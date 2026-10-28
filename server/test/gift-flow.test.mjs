import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { fixture } from './helpers.mjs';
import { MockGiftProvider } from '../dist/gifts/provider.js';
import { assertBrandedPng, saveLegacyGift } from './image-assertions.mjs';

const body = { type: 'caricature', language: 'en', wishes: 'A sunny morning' };
const inputs = {
  caricature: body,
  'greeting-card': { ...body, type: 'greeting-card', recipientName: 'PRIVATE-RECIPIENT', occasion: 'PRIVATE-OCCASION' },
  'mini-comic': { ...body, type: 'mini-comic', characterName: 'PRIVATE-CHARACTER' },
};
const paid = async (f, productId) => {
  const order = await f.create(productId);
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
      await assertBrandedPng(image.rawPayload, await readFile(new URL('../dist/assets/mock-caricature.png', import.meta.url)), 'en');
    }
    assert.deepEqual((await f.send(`/orders/${order.id}/capture`)).json().gift, gift);
    assert.equal(f.sandbox.captureKeys.length, 1);
    assert.equal(count(f, 'gift_entitlements'), 1);
    assert.equal(count(f, 'gift_images'), 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('branding failure preserves the gift right and retry saves one branded PNG', async t => {
  let calls = 0;
  const mock = new MockGiftProvider();
  const f = await fixture(t, { giftProvider: { name: 'mock', generate: async input => {
    const result = await mock.generate(input);
    if (++calls === 1) result.image.bytes = Buffer.from('invalid provider PNG');
    return result;
  } } });
  const order = await paid(f);
  const failed = await create(f, order);
  assert.equal(failed.statusCode, 503); assert.equal(failed.json().code, 'GIFT_FAILED');
  assert.equal(f.store.gift(order.id).status, 'AVAILABLE'); assert.equal(count(f, 'gift_images'), 0);
  assert.equal((await create(f, order)).json().gift.status, 'COMPLETED');
  assert.equal(count(f, 'gift_images'), 1); assert.equal(calls, 2);
});

test('unbranded stage-3C gifts survive restart and mixed old/new gifts are never reprocessed', async t => {
  const path = await temporary(t);
  const first = await fixture(t, { path });
  const mock = new MockGiftProvider();
  const legacy = [];
  for (const input of Object.values(inputs)) {
    const order = await paid(first);
    const result = await mock.generate({ ...input, product: order.product });
    saveLegacyGift(first.store, order.id, result);
    legacy.push({ order, result, gift: first.store.gift(order.id) });
  }
  const rows = first.store.db.prepare('SELECT * FROM gift_entitlements ORDER BY id').all();
  await first.app.close();
  const next = await fixture(t, { path, cookie: first.cookie, sandbox: first.sandbox });
  cleanup(t, path);
  assert.deepEqual(next.store.db.prepare('SELECT * FROM gift_entitlements ORDER BY id').all(), rows);
  for (const { order, result, gift } of legacy) {
    assert.deepEqual((await next.get(`/orders/${order.id}/gift`)).json().gift, gift);
    assert.deepEqual((await create(next, order, { ...inputs['mini-comic'], language: 'de' })).json().gift, gift);
    for (const action of ['image', 'download']) {
      const response = await next.get(`/orders/${order.id}/gift/${action}`);
      assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, result.image.bytes);
    }
    const fresh = await paid(next);
    assert.equal((await create(next, fresh, inputs[result.type])).json().gift.status, 'COMPLETED');
    const response = await next.get(`/orders/${fresh.id}/gift/download`);
    await assertBrandedPng(response.rawPayload, result.image.bytes, 'en');
  }
  assert.equal(next.store.db.pragma('user_version', { simple: true }), 4);
  assert.equal(count(next, 'gift_images'), 6); assert.equal(count(next, 'gift_entitlements'), 6);
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

test('parallel requests for different modes across two SQLite connections invoke provider once', async t => {
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
  const pending = create(first, order, inputs['greeting-card']); await started;
  const repeats = await Promise.all(Array.from({ length: 9 }, (_, i) => create(second, order, Object.values(inputs)[i % 3])));
  assert.ok(repeats.every(r => r.statusCode === 202 && r.json().gift.status === 'GENERATING'));
  assert.equal((await second.get(`/orders/${order.id}/gift/image`)).statusCode, 409);
  assert.equal(calls, 1);
  release();
  const saved = (await pending).json().gift;
  assert.equal(saved.status, 'COMPLETED'); assert.equal(saved.result.type, 'greeting-card');
  assert.deepEqual((await create(second, order, inputs['mini-comic'])).json().gift, saved);
  assert.equal(calls, 1); assert.equal(count(first, 'gift_images'), 1);
});

test('v2 restart preserves payments and all three saved modes, with one PNG per mode', async t => {
  const path = await temporary(t);
  const first = await fixture(t, { path });
  const one = await paid(first); const two = await paid(first);
  const result = (await create(first, one)).json();
  await create(first, two);
  assert.equal(count(first, 'gift_images'), 1);
  assert.equal(count(first, 'gift_entitlements'), 2);
  const schema = first.store.db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  const snapshots = [result];
  for (const input of Object.values(inputs).slice(1)) {
    const order = await paid(first);
    snapshots.push((await create(first, order, input)).json());
    await create(first, await paid(first), input);
  }
  const payments = first.store.db.prepare('SELECT * FROM orders ORDER BY id').all();
  assert.equal(count(first, 'gift_images'), 3);
  assert.equal(count(first, 'gift_entitlements'), 6);
  const cookie = first.cookie;
  await first.app.close();
  const next = await fixture(t, { path, cookie, giftProvider: { name: 'mock', generate: () => assert.fail('Saved gift must not be generated again') } });
  cleanup(t, path);
  assert.equal(next.store.db.pragma('user_version', { simple: true }), 4);
  assert.deepEqual(next.store.db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all(), schema);
  assert.deepEqual(next.store.db.prepare('SELECT * FROM orders ORDER BY id').all(), payments);
  for (const saved of snapshots) {
    assert.deepEqual((await next.get(`/orders/${saved.id}/gift`)).json(), saved);
    for (const input of Object.values(inputs)) assert.deepEqual((await create(next, saved, input)).json(), saved);
    const download = await next.get(`/orders/${saved.id}/gift/download`);
    assert.equal(download.statusCode, 200);
    await assertBrandedPng(download.rawPayload, await readFile(new URL(`../dist/assets/mock-${saved.gift.result.type}.png`, import.meta.url)), saved.gift.result.language);
  }
  assert.equal(count(next, 'gift_images'), 3);
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
  const saved = (await create(other, order, { ...inputs['mini-comic'], language: 'de' })).json().gift;
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
  assert.equal(migrated.store.db.pragma('user_version', { simple: true }), 4);
  assert.deepEqual(migrated.store.get(order.id), payment);
  assert.equal(migrated.store.gift(order.id).id, giftId);
  assert.equal((await create(migrated, order)).json().gift.status, 'COMPLETED');
});

test('gift request validation, origin, photo limits and missing fields never consume the entitlement', async t => {
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

for (const type of Object.keys(inputs)) {
  test(`${type}: EN/DE provider inputs, PNG preview/download, ownership and cross-mode replay`, async t => {
    let calls = 0, observed;
    const mock = new MockGiftProvider();
    const f = await fixture(t, { giftProvider: { name: 'mock', generate: async input => {
      calls++; observed = input; return mock.generate(input);
    } } });
    const asset = await readFile(new URL(`../dist/assets/mock-${type}.png`, import.meta.url));
    for (const language of ['en', 'de']) {
      const order = await paid(f, language === 'de' ? 'weekend-tote' : 'daybreak-mug');
      const payment = f.store.get(order.id);
      const input = { ...inputs[type], language, wishes: 'PRIVATE-WISH' };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => assert.fail('No external API calls during gift generation');
      let created;
      try { created = await create(f, order, input); } finally { globalThis.fetch = originalFetch; }
      assert.equal(created.statusCode, 200, created.body);
      const gift = created.json().gift;
      assert.equal(gift.status, 'COMPLETED');
      assert.equal(gift.result.type, type); assert.equal(gift.result.language, language);
      assert.equal(gift.result.provider, 'mock'); assert.equal(gift.result.isDemo, true);
      assert.deepEqual(observed.product, order.product);
      for (const [key, value] of Object.entries(input)) assert.equal(observed[key], value);
      assert.equal(observed.photo, undefined);
      const metadata = await sharp(asset).metadata();
      assert.equal(gift.result.width, metadata.width); assert.ok(gift.result.height > metadata.height);
      assert.equal(metadata.format, 'png'); assert.equal(metadata.exif, undefined);
      for (const suffix of ['image', 'download']) {
        const image = await f.get(`/orders/${order.id}/gift/${suffix}`);
        assert.equal(image.statusCode, 200); assert.equal(image.headers['content-type'], 'image/png');
        const branded = await assertBrandedPng(image.rawPayload, asset, language);
        assert.equal(branded.width, gift.result.width); assert.equal(branded.height, gift.result.height);
        assert.deepEqual(image.rawPayload, (await f.get(`/orders/${order.id}/gift/image`)).rawPayload);
        assert.ok(image.headers['content-disposition'].includes(`delight-${type}-${order.id}.png`));
        const stranger = (await f.app.inject('/api/store')).headers['set-cookie'].split(';')[0];
        assert.equal((await f.get(`/orders/${order.id}/gift/${suffix}`, { headers: { cookie: stranger } })).statusCode, 404);
        assert.equal((await f.send(`/orders/${order.id}/gift`, input, { headers: { cookie: stranger, origin: f.settings.origin, 'content-type': 'application/json' } })).statusCode, 404);
      }
      for (const other of Object.values(inputs)) assert.deepEqual((await create(f, order, other)).json().gift, gift);
      const row = f.store.db.prepare('SELECT * FROM gift_entitlements WHERE order_id = ?').get(order.id);
      assert.equal(row.mode, type); assert.equal(row.status, 'GENERATED'); assert.equal(row.lock_token, null);
      assert.ok(!JSON.stringify(row).includes('PRIVATE-'));
      assert.deepEqual(f.store.get(order.id), payment);
      assert.deepEqual((await f.send(`/orders/${order.id}/capture`)).json().gift, gift);
    }
    assert.equal(calls, 2); assert.equal(count(f, 'gift_images'), 2); // EN and DE have different embedded captions.
    assert.equal(count(f, 'gift_entitlements'), 2); assert.equal(f.sandbox.captureKeys.length, 2);
  });
}

test('mode-specific personalization is validated before generation and cannot consume a right', async t => {
  let calls = 0;
  const mock = new MockGiftProvider();
  const f = await fixture(t, { giftProvider: { name: 'mock', generate: async input => { calls++; return mock.generate(input); } } });
  const order = await paid(f);
  const card = inputs['greeting-card'], comic = inputs['mini-comic'];
  for (const input of [
    { ...body, type: 'unknown' }, { ...card, recipientName: '' }, { ...card, recipientName: '   ' },
    { ...card, recipientName: 'x'.repeat(81) }, { ...card, recipientName: {} },
    { ...card, occasion: undefined }, { ...card, occasion: '   ' }, { ...card, occasion: 'x'.repeat(121) },
    { ...comic, characterName: undefined }, { ...comic, characterName: '   ' },
    { ...comic, characterName: 'x'.repeat(81) }, { ...comic, characterName: {} },
    { ...card, characterName: 'unused' }, { ...comic, recipientName: 'unused' },
    { ...body, occasion: 'unused' }, { ...comic, wishes: 'x'.repeat(501) },
    ...[card, comic].map(input => ({ ...input, photo: { data: 'AAAA', contentType: 'image/png', consent: true } })),
  ]) {
    const response = await create(f, order, input);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(f.store.gift(order.id).status, 'AVAILABLE');
  }
  assert.equal(calls, 0); assert.equal(count(f, 'gift_images'), 0);
  const accepted = await create(f, order, { ...card, recipientName: 'x'.repeat(80), occasion: 'x'.repeat(120), wishes: 'x'.repeat(500) });
  assert.equal(accepted.statusCode, 200, accepted.body); assert.equal(calls, 1);
});

test('new mode failures preserve the right to choose another mode; mismatched provider output is rejected', async t => {
  for (const type of ['greeting-card', 'mini-comic']) {
    const mock = new MockGiftProvider();
    let calls = 0;
    const f = await fixture(t, { giftProvider: { name: 'mock', generate: async input => {
      if (++calls === 1) throw new Error('provider unavailable');
      if (calls === 2) return mock.generate({ ...body, product: input.product });
      return mock.generate(input);
    } } });
    const order = await paid(f);
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await create(f, order, inputs[type]);
      assert.equal(failed.statusCode, 503);
      assert.equal(f.store.gift(order.id).status, 'AVAILABLE'); assert.equal(count(f, 'gift_images'), 0);
    }
    const other = type === 'greeting-card' ? 'mini-comic' : 'greeting-card';
    const saved = (await create(f, order, inputs[other])).json().gift;
    assert.equal(saved.status, 'COMPLETED'); assert.equal(saved.result.type, other);
    assert.deepEqual((await create(f, order, inputs[type])).json().gift, saved);
    assert.equal(calls, 3); assert.equal(count(f, 'gift_images'), 1);
  }
});

test('one session buys three times: separate rights, parallel replays, private history and restart', async t => {
  const path = await temporary(t);
  let calls = 0, release, entered;
  const mock = new MockGiftProvider();
  const first = await fixture(t, { path, giftProvider: { name: 'mock', generate: async input => {
    calls++; entered(); await new Promise(resolve => { release = resolve; });
    return mock.generate(input);
  } } });
  t.after(() => release?.());
  const saved = [];
  for (const input of Object.values(inputs)) {
    const order = await paid(first);
    assert.equal(first.store.gift(order.id).status, 'AVAILABLE');
    const started = new Promise(resolve => { entered = resolve; });
    const pending = create(first, order, input);
    await started;
    const parallel = await Promise.all(Object.values(inputs).map(other => create(first, order, other)));
    assert.ok(parallel.every(r => r.statusCode === 202));
    release();
    const response = await pending;
    assert.equal(response.statusCode, 200);
    const gift = response.json().gift;
    assert.equal(gift.status, 'COMPLETED'); assert.equal(gift.result.type, input.type);
    for (const other of Object.values(inputs)) assert.deepEqual((await create(first, order, other)).json().gift, gift);
    saved.push({ order, gift });
    for (const previous of saved) assert.deepEqual(first.store.gift(previous.order.id), previous.gift);
  }
  assert.equal(calls, 3); assert.equal(first.sandbox.captureKeys.length, 3);
  assert.equal(new Set(saved.map(({ order }) => order.id)).size, 3);
  assert.equal(new Set(saved.map(({ gift }) => gift.id)).size, 3);
  assert.equal(first.store.db.prepare('SELECT COUNT(DISTINCT owner_hash) n FROM orders').get().n, 1);
  const available = await paid(first);
  await first.create(); // An unpaid order must not appear among purchases.
  const history = (await first.get('/orders')).json();
  assert.equal(history.length, 4);
  assert.equal(history.find(item => item.id === available.id).gift.status, 'AVAILABLE');
  const stranger = (await first.app.inject('/api/store')).headers['set-cookie'].split(';')[0];
  assert.deepEqual((await first.get('/orders', { headers: { cookie: stranger } })).json(), []);
  assert.equal((await first.get('/orders', { headers: { cookie: '' } })).statusCode, 401);
  await first.app.close();
  const next = await fixture(t, { path, cookie: first.cookie, giftProvider: { name: 'mock', generate: () => assert.fail('Completed gifts must survive restart') } });
  cleanup(t, path);
  assert.deepEqual((await next.get('/orders')).json(), history);
  for (const { order, gift } of saved) {
    assert.deepEqual((await next.get(`/orders/${order.id}/gift`)).json().gift, gift);
    assert.deepEqual((await create(next, order, inputs['mini-comic'])).json().gift, gift);
    const download = await next.get(`/orders/${order.id}/gift/download`);
    assert.equal(download.statusCode, 200);
    await assertBrandedPng(download.rawPayload, await readFile(new URL(`../dist/assets/mock-${gift.result.type}.png`, import.meta.url)), gift.result.language);
  }
  assert.equal(next.store.gift(available.id).status, 'AVAILABLE');
  assert.equal(count(next, 'gift_entitlements'), 4); assert.equal(count(next, 'gift_images'), 3);
});
