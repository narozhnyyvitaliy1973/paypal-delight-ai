import { createHash, randomUUID } from 'node:crypto';
import { OrderStore } from '../database.js';
import { AppError } from '../errors.js';
import { validateGiftParameters, type GiftProvider, type GiftResult } from './provider.js';
import { readAiSettings, AI_GENERATION_LEASE_MS, type AiSettings } from '../config.js';
import { reserveAiAttempt } from './limits.js';
import { AiOutcomeUnknown, AiRejected } from './cloudflare.js';
import { renderGift, type CreateGift } from './render.js';
export type { CreateGift } from './render.js';

export const GIFT_LEASE_MS = AI_GENERATION_LEASE_MS;
export class Gifts {
  constructor(private store: OrderStore, private provider: GiftProvider, private ai: AiSettings = readAiSettings(),
    private audit: (event: { orderId: string; mode: string; durationMs: number; outcome: string }) => void = () => {}) {}

  read(owner: string, id: string) {
    const order = this.store.owned(id, owner);
    if (order.status !== 'COMPLETED' || !this.store.gift(id))
      throw new AppError(409, 'PAYMENT_REQUIRED', 'A confirmed purchase is required for a gift.');
    return this.store.publicOrder(order);
  }

  async create(owner: string, id: string, input: CreateGift) {
    const order = this.read(owner, id);
    // Idempotent even if the original HTTP response was lost.
    if (order.gift!.status !== 'AVAILABLE') return order;
    validateGiftParameters(input);
    const token = randomUUID();
    const claimed = this.store.db.prepare("UPDATE gift_entitlements SET status = 'RESERVED', lock_token = ?, lock_until = ? WHERE order_id = ? AND status = 'AVAILABLE'")
      .run(token, Date.now() + GIFT_LEASE_MS, id);
    if (!claimed.changes) return this.read(owner, id);
    let aiDispatched = false;
    const started = Date.now();
    try {
      const result = await renderGift(this.provider, input, order.product, hasPhoto => {
        if (this.provider.name === 'cloudflare') {
          reserveAiAttempt(this.store.db, this.ai, token, id, owner, input.type, hasPhoto);
          aiDispatched = true;
        }
      });
      this.save(id, token, result);
      if (aiDispatched) this.audit({ orderId: id, mode: input.type, durationMs: Date.now() - started, outcome: 'COMPLETED' });
      return this.read(owner, id);
    } catch (error) {
      if (aiDispatched) {
        const rejected = error instanceof AiRejected;
        const updated = this.store.db.prepare("UPDATE ai_attempts SET status = ?, finished_at = ? WHERE id = ? AND status = 'STARTED'")
          .run(rejected ? 'REJECTED' : 'UNCERTAIN', Date.now(), token);
        this.audit({ orderId: id, mode: input.type, durationMs: Date.now() - started, outcome: rejected ? 'REJECTED' : 'UNCERTAIN' });
        if (!rejected || !updated.changes) throw new AiOutcomeUnknown();
      }
      this.store.db.prepare("UPDATE gift_entitlements SET status = 'AVAILABLE', lock_token = NULL, lock_until = 0 WHERE order_id = ? AND status = 'RESERVED' AND lock_token = ?").run(id, token);
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'GIFT_FAILED', 'Gift creation failed. Your entitlement is available to retry.');
    }
  }

  private save(id: string, token: string, result: GiftResult) {
    const hash = createHash('sha256').update(result.image.bytes).digest('hex');
    const metadata = JSON.stringify({ type: result.type, language: result.language, provider: result.provider, isDemo: result.isDemo,
      text: result.text, width: result.image.width, height: result.image.height, createdAt: Date.now() });
    this.store.db.transaction(() => {
      // Shared by content hash, survives release replacement and never duplicates the mock PNG.
      this.store.db.prepare('INSERT INTO gift_images (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING').run(hash, result.image.bytes);
      const saved = this.store.db.prepare("UPDATE gift_entitlements SET status = 'GENERATED', mode = ?, result_hash = ?, result_json = ?, lock_token = NULL, lock_until = 0 WHERE order_id = ? AND status = 'RESERVED' AND lock_token = ? AND lock_until > ?")
        .run(result.type, hash, metadata, id, token, Date.now());
      if (!saved.changes) throw new AppError(409, 'GIFT_RETRY', 'The operation expired. Check your gift and try again.');
      const attempt = this.store.db.prepare('SELECT status FROM ai_attempts WHERE id = ?').get(token) as { status: string } | undefined;
      if (attempt) {
        if (attempt.status !== 'STARTED') throw new AiOutcomeUnknown();
        this.store.db.prepare("UPDATE ai_attempts SET status = 'COMPLETED', finished_at = ? WHERE id = ?").run(Date.now(), token);
      }
    }).immediate();
  }

  image(owner: string, id: string) {
    const order = this.read(owner, id);
    if (order.gift!.status !== 'COMPLETED') throw new AppError(409, 'GIFT_NOT_READY', 'Your gift is not ready yet.');
    const image = this.store.db.prepare('SELECT i.bytes FROM gift_images i JOIN gift_entitlements g ON g.result_hash = i.hash WHERE g.order_id = ?').get(id) as { bytes: Buffer } | undefined;
    if (!image) throw new AppError(404, 'GIFT_NOT_READY', 'Your gift is not ready yet.');
    return { bytes: image.bytes, type: order.gift!.result!.type };
  }
}
