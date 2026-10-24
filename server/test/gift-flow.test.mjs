import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { fixture } from './helpers.mjs';
import { MockGiftProvider } from '../dist/gifts/provider.js';

const body = { type: 'caricature', language: 'en', wishes: 'A sunny morning' };
const paid = async f => {
  const order = await f.create();
  f.sandbox.approve(order.paypalOrderId);
  const capture = await f.send(`/orders/${order.id}/capture`);
  assert.equal(capture.statusCode, 200);
  assert.equal(capture.json().status, 'COMPLETED');
  return order;
};
const create = (f, order, input = body) => f.send(`/orders/${order.id}/gift`, input);
const count = (f, table) => f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const temporary = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-gift-test-'));
  return join(dir, 'test.sqlite');
};
// Node runs after-hooks in registration order; close SQLite before Windows unlink.
const cleanup = (t, path) => t.after(() => rm(dirname(path), { recursive: true, force: true }));

test('purchase → gift without photo → protected download; repeated creation/capture preserves one result', async t => {
  let calls = 0;
  const mock = new MockGiftProvider();
  const f = await fixture(t, { giftProvider: { name: 'mock', generate: async input => { calls++; return mock.generate(input); } } });
  const order = await paid(f);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Gift workflow must never call an external API');
  try {
    const first = await create(f, order);
    assert.equal(first.statusCode, 200, first.body);
    const gift = first.json().gift;
    assert.equal(gift.status, 'COMPLETED');
    assert.equal(gift.result.isDemo, true);
    assert.equal(gift.result.provider, 'mock');
    const repeat = await create(f, order, { ...body, language: 'de', wishes: 'Changed' });
    assert.deepEqual(repeat.json().gift, gift);
    assert.equal(calls, 1);
    for (const action of ['image', 'download']) {
      const image = await f.get(`/orders/${order.id}/gift/${action}`);
      assert.equal(image.statusCode, 200);
      assert.equal(image.headers['content-type'], 'image/png');
      assert.match(image.headers['content-disposition'], new RegExp(`^${action === 'download' ? 'attachment' : 'inline'}; filename="delight-caricature-${order.id}.png"$`));
      assert.equal(image.headers['cache-control'], 'no-store');
      assert.deepEqual(image.rawPayload, await readFile(new URL('../dist/assets/mock-caricature.png', import.meta.url)));
    }
    assert.deepEqual((await f.send(`/orders/${order.id}/capture`)).json().gift, gift);
    assert.equal(f.sandbox.captureKeys.length, 1);
    assert.equal(count(f, 'gift_entitlements'), 1);
    assert.equal(count(f, 'gift_images'), 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('photo consent, EXIF removal and provider inputs; photos/wishes never enter persistent results', async t => {
  const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).withExif({ IFD0: { Artist: 'PRIVATE-PHOTO-MARKER' } }).jpeg().toBuffer();
  let cleaned, observed;
  const mock = new MockGiftProvider();
  const f = await fixture(t, { giftProvider: { name: 'mock', generate: async input => {
    observed = input; cleaned = input.photo.bytes;
    assert.equal((await sharp(cleaned).metadata()).exif, undefined);
    assert.equal(input.photo.path, undefined);
    return mock.generate(input);
  } } });
  const order = await paid(f);
  const photo = { data: bytes.toString('base64'), contentType: 'image/jpeg', consent: false };
  const denied = await create(f, order, { ...body, photo });
  assert.equal(denied.statusCode, 400); assert.equal(denied.json().code, 'PHOTO_CONSENT_REQUIRED');
  assert.equal(observed, undefined); assert.equal(f.store.gift(order.id).status, 'AVAILABLE');
  const result = await create(f, order, { ...body, language: 'de', wishes: 'PRIVATE-WISH-MARKER', photo: { ...photo, consent: true } });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(observed.language, 'de'); assert.equal(observed.wishes, 'PRIVATE-WISH-MARKER');
  assert.deepEqual(observed.product, { id: 'daybreak-mug', name: 'Daybreak Mug' });
  assert.ok(cleaned.every(byte => byte === 0));
  assert.equal(result.json().gift.result.language, 'de');
  const persisted = JSON.stringify(f.store.db.prepare('SELECT * FROM gift_entitlements').all());
  assert.ok(!persisted.includes('PRIVATE-')); assert.ok(!persisted.includes(photo.data));
});

test('unpaid, cancelled, pending, declined, foreign and missing sessions cannot create or read a gift', async t => {
  for (const status of ['CREATED', 'CANCELLED', 'PENDING', 'DECLINED']) {
    const f = await fixture(t);
    const order = await f.create();
    if (status === 'CANCELLED') await f.send(`/orders/${order.id}/cancel`);
    if (['PENDING', 'DECLINED'].includes(status)) {
      f.sandbox.captureStatus = status; f.sandbox.approve(order.paypalOrderId);
      await f.send(`/orders/${order.id}/capture`);
    }
    assert.equal((await create(f, order)).statusCode, 409);
    assert.equal((await f.get(`/orders/${order.id}/gift/image`)).statusCode, 409);
    assert.equal(count(f, 'gift_images'), 0);
  }
  const f = await fixture(t);
  const order = await paid(f);
  await create(f, order);
  const stranger = (await f.app.inject('/api/store')).headers['set-cookie'].split(';')[0];
  for (const cookie of [stranger, '']) {
    const code = cookie ? 404 : 401;
    for (const suffix of ['', '/image', '/download']) assert.equal((await f.get(`/orders/${order.id}/gift${suffix}`, { headers: { cookie } })).statusCode, code);
    assert.equal((await f.send(`/orders/${order.id}/gift`, body, { headers: { cookie, origin: f.settings.origin, 'content-type': 'application/json' } })).statusCode, code);
  }
});

test('generation failure releases entitlement and retry succeeds', async t => {
  let calls = 0;
  const mock = new MockGiftProvider();
  const f = await fixture(t, { giftProvider: { name: 'mock', generate: async input => { if (++calls === 1) throw new Error('private provider details'); return mock.generate(input); } } });
  const order = await paid(f);
  const failed = await create(f, order);
  assert.equal(failed.statusCode, 503); assert.equal(failed.json().code, 'GIFT_FAILED');
  assert.ok(!failed.body.includes('private'));
  assert.equal(f.store.gift(order.id).status, 'AVAILABLE'); assert.equal(count(f, 'gift_images'), 0);
  assert.equal((await create(f, order)).json().gift.status, 'COMPLETED');
  assert.equal(calls, 2);
});

test('result saving failure rolls back image and entitlement together', async t => {
  const f = await fixture(t);
  const order = await paid(f);
  f.store.db.exec("CREATE TRIGGER fail_gift_save BEFORE UPDATE ON gift_entitlements WHEN NEW.status = 'GENERATED' BEGIN SELECT RAISE(ABORT, 'simulated disk error'); END;");
  const failed = await create(f, order);
  assert.equal(failed.statusCode, 503);
  assert.equal(f.store.gift(order.id).status, 'AVAILABLE'); assert.equal(count(f, 'gift_images'), 0);
  f.store.db.exec('DROP TRIGGER fail_gift_save');
  assert.equal((await create(f, order)).json().gift.status, 'COMPLETED');
});

test('parallel requests across two SQLite connections invoke provider once', async t => {
  const path = await temporary(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  let calls = 0;
  const mock = new MockGiftProvider();
  const provider = { name: 'mock', generate: async input => { calls++; entered(); await gate; return mock.generate(input); } };
  const first = await fixture(t, { path, giftProvider: provider });
  const order = await paid(first);
  const second = await fixture(t, { path, cookie: first.cookie, sandbox: first.sandbox, giftProvider: provider });
  cleanup(t, path);
  const pending = create(first, order); await started;
  const repeats = await Promise.all(Array.from({ length: 8 }, () => create(second, order)));
  assert.ok(repeats.every(r => r.statusCode === 202 && r.json().gift.status === 'GENERATING'));
  assert.equal((await second.get(`/orders/${order.id}/gift/image`)).statusCode, 409);
  assert.equal(calls, 1);
  release(); assert.equal((await pending).json().gift.status, 'COMPLETED');
  assert.equal((await create(second, order)).json().gift.status, 'COMPLETED');
  assert.equal(calls, 1); assert.equal(count(first, 'gift_images'), 1);
});

test('restart restores saved result and identical mock images are stored only once', async t => {
  const path = await temporary(t);
  const first = await fixture(t, { path });
  const one = await paid(first); const two = await paid(first);
  const result = (await create(first, one)).json();
  await create(first, two);
  assert.equal(count(first, 'gift_images'), 1);
  assert.equal(count(first, 'gift_entitlements'), 2);
  const cookie = first.cookie;
  await first.app.close();
  const next = await fixture(t, { path, cookie, giftProvider: { name: 'mock', generate: () => assert.fail('Saved gift must not be generated again') } });
  cleanup(t, path);
  assert.deepEqual((await next.get(`/orders/${one.id}/gift`)).json(), result);
  assert.deepEqual((await create(next, one)).json(), result);
  assert.equal((await next.get(`/orders/${one.id}/gift/download`)).statusCode, 200);
});

test('expired crash lease is recovered after restart; a stale worker cannot overwrite a newer result', async t => {
  const path = await temporary(t);
  const first = await fixture(t, { path });
  const order = await paid(first);
  first.store.db.prepare("UPDATE gift_entitlements SET status = 'RESERVED', lock_token = 'crashed', lock_until = ? WHERE order_id = ?").run(Date.now() + 100000, order.id);
  await first.app.close();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const mock = new MockGiftProvider();
  const next = await fixture(t, { path, cookie: first.cookie, giftProvider: { name: 'mock', generate: async input => { entered(); await gate; return mock.generate(input); } } });
  assert.equal((await next.get(`/orders/${order.id}/gift`)).json().gift.status, 'GENERATING');
  next.store.db.prepare('UPDATE gift_entitlements SET lock_until = 0').run();
  assert.equal((await next.get(`/orders/${order.id}/gift`)).json().gift.status, 'AVAILABLE');
  const stale = create(next, order); await started;
  next.store.db.prepare('UPDATE gift_entitlements SET lock_until = 0').run();
  const other = await fixture(t, { path, cookie: first.cookie });
  cleanup(t, path);
  const saved = (await create(other, order, { ...body, language: 'de' })).json().gift;
  assert.equal(saved.status, 'COMPLETED');
  release(); assert.equal((await stale).statusCode, 409);
  assert.deepEqual(next.store.gift(order.id), saved);
  assert.equal(count(next, 'gift_images'), 1);
});

test('version 1 migration preserves payment rows and existing gift entitlement IDs', async t => {
  const path = await temporary(t);
  const first = await fixture(t, { path });
  const order = await paid(first);
  const payment = first.store.get(order.id);
  const giftId = first.store.gift(order.id).id;
  // Remove only v2 additions, producing exactly the existing stage-2/3A schema.
  first.store.db.exec(`ALTER TABLE gift_entitlements DROP COLUMN result_hash;
    ALTER TABLE gift_entitlements DROP COLUMN result_json;
    ALTER TABLE gift_entitlements DROP COLUMN lock_token;
    ALTER TABLE gift_entitlements DROP COLUMN lock_until;
    DROP TABLE gift_images; PRAGMA user_version = 1;`);
  await first.app.close();
  const migrated = await fixture(t, { path, cookie: first.cookie });
  cleanup(t, path);
  assert.equal(migrated.store.db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(migrated.store.get(order.id), payment);
  assert.equal(migrated.store.gift(order.id).id, giftId);
  assert.equal((await create(migrated, order)).json().gift.status, 'COMPLETED');
});

test('gift request validation, origin, photo limits and unavailable modes never consume the entitlement', async t => {
  const f = await fixture(t);
  const order = await paid(f);
  const image = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'red' } }).png().toBuffer();
  const cases = [
    { ...body, type: 'greeting-card' }, { ...body, type: 'mini-comic' }, { ...body, language: 'fr' },
    { ...body, wishes: 'x'.repeat(501) }, { ...body, product: { id: 'injected' } }, { ...body, status: 'COMPLETED' },
    { ...body, photo: { data: '%%%%', contentType: 'image/png', consent: true } },
    { ...body, photo: { data: Buffer.from('<svg/>').toString('base64'), contentType: 'image/png', consent: true } },
    { ...body, photo: { data: image.toString('base64'), contentType: 'image/png', consent: true } },
    { ...body, photo: { data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'), contentType: 'image/png', consent: true } },
    { ...body, photo: { data: 'AAAA', contentType: 'image/png' } },
  ];
  for (const input of cases) {
    const response = await create(f, order, input);
    assert.ok([400, 413].includes(response.statusCode), response.body);
    assert.equal(f.store.gift(order.id).status, 'AVAILABLE');
  }
  assert.equal((await f.send(`/orders/${order.id}/gift`, body, { headers: { cookie: f.cookie, origin: 'https://foreign.example', 'content-type': 'application/json' } })).statusCode, 403);
  assert.equal((await create(f, order, { ...body, wishes: 'x'.repeat(7 * 1024 * 1024) })).statusCode, 413);
  assert.equal(count(f, 'gift_images'), 0);
});
