import { createHash, randomUUID } from 'node:crypto';
import { OrderStore } from '../database.js';
import { AppError } from '../errors.js';
import { withPreparedPhoto, PHOTO_MAX_BYTES } from './photo.js';
import type { GiftProvider, GiftLanguage, GiftResult } from './provider.js';

export interface CreateGift {
  type: 'caricature'; language: GiftLanguage; wishes: string;
  photo?: { data: string; contentType: string; consent: boolean };
}
export const GIFT_LEASE_MS = 120_000;
export class Gifts {
  constructor(private store: OrderStore, private provider: GiftProvider) {}

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
    const token = randomUUID();
    const claimed = this.store.db.prepare("UPDATE gift_entitlements SET status = 'RESERVED', lock_token = ?, lock_until = ? WHERE order_id = ? AND status = 'AVAILABLE'")
      .run(token, Date.now() + GIFT_LEASE_MS, id);
    if (!claimed.changes) return this.read(owner, id);
    try {
      if (input.photo && input.photo.consent !== true)
        throw new AppError(400, 'PHOTO_CONSENT_REQUIRED', 'Separate photo consent is required.');
      if (input.photo && (input.photo.data.length > Math.ceil(PHOTO_MAX_BYTES / 3) * 4 ||
          input.photo.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.photo.data)))
        throw new AppError(400, 'PHOTO_INVALID', 'Invalid photo encoding.');
      const upload = input.photo ? { bytes: Buffer.from(input.photo.data, 'base64'), contentType: input.photo.contentType, consent: input.photo.consent } : undefined;
      const result = await withPreparedPhoto(upload, async photo => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.provider.generate({ type: input.type, product: order.product, language: input.language, wishes: input.wishes, photo }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Gift timeout')), 60_000); }),
          ]);
        } finally { clearTimeout(timer); }
      });
      this.save(id, token, result);
      return this.read(owner, id);
    } catch (error) {
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
      const saved = this.store.db.prepare("UPDATE gift_entitlements SET status = 'GENERATED', mode = 'caricature', result_hash = ?, result_json = ?, lock_token = NULL, lock_until = 0 WHERE order_id = ? AND status = 'RESERVED' AND lock_token = ? AND lock_until > ?")
        .run(hash, metadata, id, token, Date.now());
      if (!saved.changes) throw new AppError(409, 'GIFT_RETRY', 'The operation expired. Check your gift and try again.');
    }).immediate();
  }

  image(owner: string, id: string) {
    const order = this.read(owner, id);
    if (order.gift!.status !== 'COMPLETED') throw new AppError(409, 'GIFT_NOT_READY', 'Your gift is not ready yet.');
    const image = this.store.db.prepare('SELECT i.bytes FROM gift_images i JOIN gift_entitlements g ON g.result_hash = i.hash WHERE g.order_id = ?').get(id) as { bytes: Buffer } | undefined;
    if (!image) throw new AppError(404, 'GIFT_NOT_READY', 'Your gift is not ready yet.');
    return image.bytes;
  }
}
