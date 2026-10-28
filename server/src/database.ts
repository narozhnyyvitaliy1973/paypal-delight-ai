import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Product } from "./catalog.js";
import { AppError } from "./errors.js";
import type { GiftType } from './gifts/provider.js';
import { expireAiAttempts } from './gifts/limits.js';

export type OrderStatus =
  | "CREATING"
  | "CREATED"
  | "PENDING"
  | "COMPLETED"
  | "CANCELLED"
  | "DECLINED"
  | "REVIEW";
export interface Order {
  id: string;
  owner_hash: string;
  client_key: string;
  product_id: string;
  product_name: string;
  amount_minor: number;
  currency: string;
  status: OrderStatus;
  paypal_order_id: string | null;
  payee_id: string | null;
  capture_id: string | null;
  create_request_id: string;
  capture_request_id: string;
  capture_attempted: number;
  created_at: number;
  updated_at: number;
  lock_token: string | null;
  lock_until: number;
}
export interface Gift {
  id: string;
  order_id: string;
  status: "AVAILABLE" | "GENERATING" | "COMPLETED" | "REVIEW";
  result: null | { type: GiftType; language: 'en' | 'de'; provider: 'mock' | 'openai' | 'cloudflare'; isDemo: boolean; text: string; width: number; height: number; createdAt: number; imageUrl: string; downloadUrl: string };
}

export class OrderStore {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    const version = this.db.pragma("user_version", { simple: true });
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4) {
      this.db.close();
      throw new Error("Unsupported database schema version.");
    }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, client_key TEXT NOT NULL,
          product_id TEXT NOT NULL, product_name TEXT NOT NULL,
          amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL CHECK(currency = 'EUR'),
          status TEXT NOT NULL CHECK(status IN ('CREATING','CREATED','PENDING','COMPLETED','CANCELLED','DECLINED','REVIEW')),
          paypal_order_id TEXT UNIQUE, payee_id TEXT, capture_id TEXT UNIQUE,
          create_request_id TEXT NOT NULL UNIQUE, capture_request_id TEXT NOT NULL UNIQUE,
          capture_attempted INTEGER NOT NULL DEFAULT 0 CHECK(capture_attempted IN (0,1)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lock_token TEXT, lock_until INTEGER NOT NULL DEFAULT 0,
          UNIQUE(owner_hash, client_key),
          CHECK(status != 'COMPLETED' OR (paypal_order_id IS NOT NULL AND capture_id IS NOT NULL AND payee_id IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS gift_entitlements (
          id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
          status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','RESERVED','GENERATED')),
          mode TEXT CHECK(mode IN ('caricature','greeting-card','mini-comic')),
          result_path TEXT, created_at INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS gift_requires_payment BEFORE INSERT ON gift_entitlements
        WHEN (SELECT status FROM orders WHERE id = NEW.order_id) != 'COMPLETED'
        BEGIN SELECT RAISE(ABORT, 'Payment required'); END;
      `);
      if (version === 0 || version === 1) {
        // Additive migration: payment rows and existing entitlements stay intact.
        // Keep the original SQL status names; expose the new lifecycle through gift().
        this.db.exec(`
          CREATE TABLE gift_images (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
          ALTER TABLE gift_entitlements ADD COLUMN result_hash TEXT REFERENCES gift_images(hash);
          ALTER TABLE gift_entitlements ADD COLUMN result_json TEXT;
          ALTER TABLE gift_entitlements ADD COLUMN lock_token TEXT;
          ALTER TABLE gift_entitlements ADD COLUMN lock_until INTEGER NOT NULL DEFAULT 0;
          PRAGMA user_version = 2;
        `);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ai_attempts (
          id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
          mode TEXT NOT NULL CHECK(mode IN ('caricature','greeting-card','mini-comic')),
          status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','REJECTED','UNCERTAIN','RELEASED')),
          started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, finished_at INTEGER,
          estimated_neurons INTEGER NOT NULL CHECK(estimated_neurons > 0)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ai_one_active_attempt ON ai_attempts(order_id)
          WHERE status IN ('STARTED','UNCERTAIN','COMPLETED');
        CREATE INDEX IF NOT EXISTS ai_daily_usage ON ai_attempts(deadline);
        CREATE TABLE IF NOT EXISTS ai_lab_runs (
          id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, product_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('caricature','greeting-card','mini-comic')),
          language TEXT NOT NULL CHECK(language IN ('en','de')),
          status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','REJECTED','UNCERTAIN')),
          started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, finished_at INTEGER,
          estimated_neurons INTEGER NOT NULL CHECK(estimated_neurons >= 0),
          error_code TEXT, result_json TEXT, image BLOB
        );
        CREATE INDEX IF NOT EXISTS ai_lab_owner ON ai_lab_runs(owner_hash, started_at);
        CREATE INDEX IF NOT EXISTS ai_lab_daily ON ai_lab_runs(deadline);
        PRAGMA user_version = 4;
      `);
    })();
  }

  close() {
    this.db.close();
  }
  get(id: string) {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as
      Order | undefined;
  }
  owned(id: string, owner: string) {
    const order = this.get(id);
    if (!order || order.owner_hash !== owner)
      throw new AppError(
        404,
        "ORDER_NOT_FOUND",
        "Order not found in this browser session.",
      );
    return order;
  }
  purchases(owner: string) {
    const orders = this.db.prepare("SELECT * FROM orders WHERE owner_hash = ? AND status = 'COMPLETED' ORDER BY created_at DESC, id DESC").all(owner) as Order[];
    return orders.map(order => this.publicOrder(order));
  }
  prepare(owner: string, key: string, product: Product): Order {
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT * FROM orders WHERE owner_hash = ? AND client_key = ?",
          )
          .get(owner, key) as Order | undefined;
        if (existing) {
          if (existing.product_id !== product.id)
            throw new AppError(
              409,
              "REQUEST_CONFLICT",
              "This purchase request belongs to another product.",
            );
          return existing;
        }
        const id = randomUUID();
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO orders (id, owner_hash, client_key, product_id, product_name, amount_minor, currency,
        status, create_request_id, capture_request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATING', ?, ?, ?, ?)`,
          )
          .run(
            id,
            owner,
            key,
            product.id,
            product.name,
            product.amountMinor,
            product.currency,
            randomUUID(),
            randomUUID(),
            now,
            now,
          );
        return this.get(id)!;
      })
      .immediate();
  }
  claim(id: string) {
    const token = randomUUID();
    const now = Date.now();
    const result = this.db
      .prepare(
        "UPDATE orders SET lock_token = ?, lock_until = ? WHERE id = ? AND lock_until <= ?",
      )
      .run(token, now + 120_000, id, now);
    if (!result.changes)
      throw new AppError(
        409,
        "ORDER_BUSY",
        "This order is being processed. Please check again shortly.",
      );
    return token;
  }
  release(id: string, token: string) {
    this.db
      .prepare(
        "UPDATE orders SET lock_token = NULL, lock_until = 0 WHERE id = ? AND lock_token = ?",
      )
      .run(id, token);
  }
  created(id: string, paypalId: string, payeeId: string) {
    this.db
      .prepare(
        "UPDATE orders SET paypal_order_id = ?, payee_id = ?, status = 'CREATED', updated_at = ? WHERE id = ?",
      )
      .run(paypalId, payeeId, Date.now(), id);
  }
  status(id: string, status: OrderStatus) {
    this.db
      .prepare(
        "UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status != 'COMPLETED'",
      )
      .run(status, Date.now(), id);
  }
  attempted(id: string) {
    this.db
      .prepare(
        "UPDATE orders SET capture_attempted = 1, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
  }
  observedCapture(
    id: string,
    status: "PENDING" | "DECLINED",
    captureId: string,
  ) {
    const order = this.get(id)!;
    if (order.capture_id && order.capture_id !== captureId)
      throw new AppError(
        409,
        "PAYMENT_MISMATCH",
        "Payment needs manual review.",
      );
    this.db
      .prepare(
        "UPDATE orders SET status = ?, capture_id = ?, updated_at = ? WHERE id = ? AND status != 'COMPLETED'",
      )
      .run(status, captureId, Date.now(), id);
  }
  complete(id: string, captureId: string) {
    this.db
      .transaction(() => {
        const order = this.get(id)!;
        if (order.capture_id && order.capture_id !== captureId)
          throw new AppError(
            409,
            "PAYMENT_MISMATCH",
            "Payment needs manual review.",
          );
        this.db
          .prepare(
            "UPDATE orders SET status = 'COMPLETED', capture_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(captureId, Date.now(), id);
        this.db
          .prepare(
            "INSERT INTO gift_entitlements (id, order_id, created_at) VALUES (?, ?, ?) ON CONFLICT(order_id) DO NOTHING",
          )
          .run(randomUUID(), id, Date.now());
      })
      .immediate();
  }
  gift(id: string) {
    // Mock leases are recoverable. A dispatched AI request must NEVER auto-retry,
    // including after a crash, server restart or switching back to the mock provider.
    expireAiAttempts(this.db);
    this.db.prepare("UPDATE gift_entitlements SET status = 'AVAILABLE', lock_token = NULL, lock_until = 0 WHERE order_id = ? AND status = 'RESERVED' AND lock_until <= ? AND NOT EXISTS (SELECT 1 FROM ai_attempts WHERE order_id = gift_entitlements.order_id AND status IN ('STARTED','UNCERTAIN','COMPLETED'))").run(id, Date.now());
    const row = this.db.prepare('SELECT id, order_id, status, result_json FROM gift_entitlements WHERE order_id = ?').get(id) as
      { id: string; order_id: string; status: 'AVAILABLE' | 'RESERVED' | 'GENERATED'; result_json: string | null } | undefined;
    if (!row) return undefined;
    const review = this.db.prepare("SELECT 1 FROM ai_attempts WHERE order_id = ? AND status = 'UNCERTAIN'").get(id);
    return {
      id: row.id, order_id: row.order_id,
      status: row.status === 'GENERATED' ? 'COMPLETED' : review ? 'REVIEW' : row.status === 'RESERVED' ? 'GENERATING' : 'AVAILABLE',
      result: row.result_json ? { ...JSON.parse(row.result_json), imageUrl: `/api/orders/${id}/gift/image`, downloadUrl: `/api/orders/${id}/gift/download` } : null,
    } as Gift;
  }
  publicOrder(order: Order) {
    return {
      id: order.id,
      product: { id: order.product_id, name: order.product_name },
      amountMinor: order.amount_minor,
      currency: order.currency,
      status: order.status,
      paypalOrderId: order.paypal_order_id,
      captureId: order.capture_id,
      captureAttempted: Boolean(order.capture_attempted),
      gift: order.status === "COMPLETED" ? (this.gift(order.id) ?? null) : null,
    };
  }
}
