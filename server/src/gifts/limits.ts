import type Database from 'better-sqlite3';
import { AppError } from '../errors.js';
import { AI_GENERATION_LEASE_MS, type AiSettings } from '../config.js';
import type { GiftType } from './provider.js';
import { estimatedNeurons } from './prompts.js';

export function expireAiAttempts(db: Database.Database, now = Date.now()) {
  db.prepare("UPDATE ai_attempts SET status = 'UNCERTAIN', finished_at = ? WHERE status = 'STARTED' AND deadline <= ?").run(now, now);
  db.prepare("UPDATE ai_lab_runs SET status = 'UNCERTAIN', error_code = 'AI_LAB_UNCERTAIN', finished_at = ? WHERE status = 'STARTED' AND deadline <= ?").run(now, now);
}

// Both entry points use the same database transaction and durable account budget.
export function aiUsage(db: Database.Database, owner: string, now = Date.now()) {
  const start = Math.floor(now / 86_400_000) * 86_400_000;
  return db.prepare(`SELECT COUNT(*) requests, COALESCE(SUM(estimated_neurons), 0) neurons,
    COALESCE(SUM(CASE WHEN owner_hash = ? THEN 1 ELSE 0 END), 0) sessionRequests,
    COALESCE(SUM(CASE WHEN status = 'STARTED' AND deadline > ? THEN 1 ELSE 0 END), 0) active
    FROM (
      SELECT o.owner_hash, a.status, a.deadline, a.estimated_neurons FROM ai_attempts a JOIN orders o ON o.id = a.order_id
      UNION ALL SELECT owner_hash, status, deadline, estimated_neurons FROM ai_lab_runs WHERE estimated_neurons > 0
    ) WHERE deadline >= ?`).get(owner, now, start) as { requests: number; neurons: number; sessionRequests: number; active: number };
}

export function checkAiBudget(db: Database.Database, settings: AiSettings, owner: string, hasPhoto: boolean) {
  if (!settings.enabled) throw new AppError(503, 'AI_DISABLED', 'AI generation is disabled.');
  expireAiAttempts(db);
  const cost = estimatedNeurons(hasPhoto);
  const usage = aiUsage(db, owner);
  if (usage.active >= settings.maxConcurrent) throw new AppError(429, 'AI_BUSY', 'AI generation is busy. Please try later.');
  if (usage.sessionRequests >= settings.sessionDailyRequests) throw new AppError(429, 'AI_SESSION_LIMIT', 'This browser session has reached its daily generation limit.');
  if (usage.requests >= settings.dailyRequests || usage.neurons + cost > settings.dailyNeurons)
    throw new AppError(429, 'AI_DAILY_LIMIT', 'The daily AI budget is reserved. Please try after 00:00 UTC.');
  return cost;
}

export function reserveAiAttempt(db: Database.Database, settings: AiSettings, id: string, orderId: string, owner: string, mode: GiftType, hasPhoto: boolean) {
  if (!settings.enabled) throw new AppError(503, 'AI_DISABLED', 'AI generation is disabled. Your gift right is preserved.');
  const now = Date.now();
  db.transaction(() => {
    const reserved = db.prepare("SELECT 1 FROM gift_entitlements WHERE order_id = ? AND status = 'RESERVED' AND lock_token = ? AND lock_until > ?").get(orderId, id, now);
    if (!reserved) throw new AppError(409, 'GIFT_RETRY', 'Check your gift status.');
    const cost = checkAiBudget(db, settings, owner, hasPhoto);
    // Reserve before dispatch; failures/uncertainty count too. Never refund automatically.
    db.prepare("INSERT INTO ai_attempts (id, order_id, mode, status, started_at, deadline, estimated_neurons) VALUES (?, ?, ?, 'STARTED', ?, ?, ?)")
      .run(id, orderId, mode, now, now + AI_GENERATION_LEASE_MS, cost);
  }).immediate();
}

// Operator-only, never exposed through HTTP. Preserves the attempt and its charged
// budget. The operator must verify the outcome and explicitly authorise a new attempt.
export function releaseReviewedAttempt(db: Database.Database, orderId: string, attemptId: string) {
  db.transaction(() => {
    expireAiAttempts(db);
    const row = db.prepare("SELECT 1 FROM ai_attempts a JOIN gift_entitlements g ON g.order_id = a.order_id WHERE a.id = ? AND a.order_id = ? AND a.status = 'UNCERTAIN' AND g.status = 'RESERVED' AND g.result_hash IS NULL AND g.lock_token = a.id").get(attemptId, orderId);
    if (!row) throw new Error('Only the current uncertain attempt without a saved gift can be released.');
    db.prepare("UPDATE ai_attempts SET status = 'RELEASED', finished_at = ? WHERE id = ?").run(Date.now(), attemptId);
    db.prepare("UPDATE gift_entitlements SET status = 'AVAILABLE', lock_token = NULL, lock_until = 0 WHERE order_id = ? AND lock_token = ?").run(orderId, attemptId);
  }).immediate();
}
