import type { OrderStore } from '../database.js';
import { AI_GENERATION_LEASE_MS, type AiSettings } from '../config.js';
import { AppError } from '../errors.js';
import { products } from '../catalog.js';
import type { GiftProvider, GiftType } from './provider.js';
import { validateGiftParameters } from './provider.js';
import { renderGift, type CreateGift } from './render.js';
import { checkAiBudget, expireAiAttempts } from './limits.js';
import { AiRejected } from './cloudflare.js';

interface Run {
  id: string; owner_hash: string; product_id: string; mode: GiftType; language: 'en' | 'de';
  status: 'STARTED' | 'COMPLETED' | 'REJECTED' | 'UNCERTAIN'; started_at: number;
  error_code: string | null; result_json: string | null;
}

export class AiLab {
  constructor(private store: OrderStore, private provider: GiftProvider, private settings: AiSettings) {}

  private owned(owner: string, id: string) {
    expireAiAttempts(this.store.db);
    const row = this.store.db.prepare('SELECT id,owner_hash,product_id,mode,language,status,started_at,error_code,result_json FROM ai_lab_runs WHERE id = ?').get(id) as Run | undefined;
    if (row && row.owner_hash !== owner) throw new AppError(404, 'AI_LAB_NOT_FOUND', 'Test not found.');
    return row;
  }
  private view(row: Run) {
    return { id: row.id, productId: row.product_id, type: row.mode, language: row.language,
      status: row.status, createdAt: row.started_at, errorCode: row.error_code,
      result: row.result_json ? { ...JSON.parse(row.result_json),
        imageUrl: `/api/ai-lab/runs/${row.id}/image`, downloadUrl: `/api/ai-lab/runs/${row.id}/download` } : null };
  }
  read(owner: string, id: string) {
    const row = this.owned(owner, id);
    if (!row) throw new AppError(404, 'AI_LAB_NOT_FOUND', 'Test not found.');
    return this.view(row);
  }
  list(owner: string) {
    expireAiAttempts(this.store.db);
    const rows = this.store.db.prepare('SELECT id,owner_hash,product_id,mode,language,status,started_at,error_code,result_json FROM ai_lab_runs WHERE owner_hash = ? ORDER BY started_at DESC LIMIT 100').all(owner) as Run[];
    return rows.map(row => this.view(row));
  }
  async create(owner: string, id: string, productId: string, input: CreateGift) {
    const existing = this.owned(owner, id);
    if (existing) return this.view(existing);
    validateGiftParameters(input);
    const product = products.find(p => p.id === productId);
    if (!product) throw new AppError(400, 'INVALID_REQUEST', 'Unknown product.');
    let reserved = false;
    try {
      const result = await renderGift(this.provider, input, product, hasPhoto => {
        this.store.db.transaction(() => {
          if (this.owned(owner, id)) throw new AppError(409, 'AI_LAB_REPLAY', 'This test already exists.');
          const cost = this.provider.name === 'cloudflare' ? checkAiBudget(this.store.db, this.settings, owner, hasPhoto) : 0;
          // Also bound mock image processing. New IDs never bypass concurrency limits.
          const active = this.store.db.prepare("SELECT COUNT(*) n FROM ai_lab_runs WHERE status = 'STARTED'").get() as { n: number };
          if (active.n >= this.settings.maxConcurrent) throw new AppError(429, 'AI_BUSY', 'AI generation is busy.');
          const now = Date.now();
          this.store.db.prepare("INSERT INTO ai_lab_runs (id,owner_hash,product_id,mode,language,status,started_at,deadline,estimated_neurons) VALUES (?,?,?,?,?,'STARTED',?,?,?)")
            .run(id, owner, product.id, input.type, input.language, now, now + AI_GENERATION_LEASE_MS, cost);
          reserved = true;
        }).immediate();
      });
      const metadata = JSON.stringify({ type: result.type, language: result.language, provider: result.provider, isDemo: result.isDemo,
        text: result.text, width: result.image.width, height: result.image.height, createdAt: Date.now() });
      const saved = this.store.db.prepare("UPDATE ai_lab_runs SET status = 'COMPLETED', finished_at = ?, result_json = ?, image = ? WHERE id = ? AND status = 'STARTED' AND deadline > ?")
        .run(Date.now(), metadata, result.image.bytes, id, Date.now());
      if (!saved.changes) throw new Error('Expired test');
    } catch (error) {
      if (!reserved) {
        const concurrent = this.owned(owner, id);
        if (concurrent) return this.view(concurrent);
        throw error;
      }
      const uncertain = this.provider.name === 'cloudflare' && !(error instanceof AiRejected);
      this.store.db.prepare("UPDATE ai_lab_runs SET status = ?, error_code = ?, finished_at = ? WHERE id = ? AND status = 'STARTED'")
        .run(uncertain ? 'UNCERTAIN' : 'REJECTED', uncertain ? 'AI_LAB_UNCERTAIN' : 'AI_LAB_REJECTED', Date.now(), id);
    }
    // A failed test never holds a purchase entitlement. A NEW manual test needs a new ID,
    // keeps the previous cost charged, and goes through the same durable budget checks.
    return this.read(owner, id);
  }
  image(owner: string, id: string) {
    const row = this.owned(owner, id);
    if (!row || row.status !== 'COMPLETED') throw new AppError(404, 'AI_LAB_NOT_FOUND', 'Test image not found.');
    const image = this.store.db.prepare('SELECT image FROM ai_lab_runs WHERE id = ?').get(id) as { image: Buffer };
    return { bytes: image.image, type: row.mode };
  }
}
