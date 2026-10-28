// Offline operator tool. Never calls a provider, creates a gift or erases usage.
// Stop this application's server first; explicitly select its existing DATABASE_PATH.
import { existsSync } from 'node:fs';
import { loadRootEnv, readSettings } from './config.js';
import { OrderStore } from './database.js';
import { expireAiAttempts, releaseReviewedAttempt } from './gifts/limits.js';

const [orderId, attemptId, confirmation, extra] = process.argv.slice(2);
if (!orderId || !/^[a-f0-9-]{36}$/.test(orderId) || extra ||
    (attemptId && (!/^[a-f0-9-]{36}$/.test(attemptId) || confirmation !== '--authorise-another-attempt'))) {
  console.error('Inspect: node server/dist/review-ai-attempt.js ORDER_ID\nAfter reviewing Cloudflare usage/outcome, explicitly permit a later manual generation (it may consume additional Neurons):\nnode server/dist/review-ai-attempt.js ORDER_ID ATTEMPT_ID --authorise-another-attempt');
  process.exitCode = 1;
} else {
  let store: OrderStore | undefined;
  try {
    loadRootEnv();
    if (!process.env.DATABASE_PATH?.trim()) throw new Error('Explicit database required');
    const settings = readSettings();
    if (!existsSync(settings.databasePath)) throw new Error('Existing database required');
    store = new OrderStore(settings.databasePath);
    expireAiAttempts(store.db);
    if (attemptId) releaseReviewedAttempt(store.db, orderId, attemptId);
    console.log(JSON.stringify(store.db.prepare('SELECT id, mode, status, started_at, deadline, estimated_neurons FROM ai_attempts WHERE order_id = ? ORDER BY started_at').all(orderId), null, 2));
  } catch {
    console.error('Could not complete review. Set DATABASE_PATH to the existing service database. Only the current uncertain attempt without a saved result can be released.');
    process.exitCode = 1;
  } finally { store?.close(); }
}
