import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { fixture } from './helpers.mjs';
import { FakeCloudflare, giftInputs, aiSettings } from './cloudflare-helpers.mjs';
import { readSettings, readAiSettings } from '../dist/config.js';
import { products } from '../dist/catalog.js';
import { CloudflareGiftProvider } from '../dist/gifts/cloudflare.js';
import { letterGiftImage, plainText } from '../dist/gifts/lettering.js';
import { brandGiftImage } from '../dist/gifts/branding.js';
import { giftPrompt, estimatedNeurons, comicStory } from '../dist/gifts/prompts.js';
import { releaseReviewedAttempt } from '../dist/gifts/limits.js';
import { Gifts } from '../dist/gifts/service.js';
import { assertBrandedPng, saveLegacyGift } from './image-assertions.mjs';
import { MockGiftProvider } from '../dist/gifts/provider.js';
import { withPreparedPhoto } from '../dist/gifts/photo.js';

// This file has no permitted network path. Both provider transports are injected.
globalThis.fetch = () => { throw new Error('Real HTTP is forbidden in Cloudflare tests'); };
const owner = f => createHash('sha256').update(f.cookie.split('=')[1]).digest('hex');
const paid = f => {
  const order = f.store.prepare(owner(f), randomUUID(), products[0]);
  f.store.created(order.id, `TEST-${randomUUID()}`, 'TEST-MERCHANT');
  f.store.complete(order.id, `TEST-${randomUUID()}`);
  return order;
};
const create = (f, order, body = giftInputs.caricature) => f.send(`/orders/${order.id}/gift`, body);

test('Cloudflare is opt-in, model and budgets are bounded, invalid config fails closed', () => {
  const settings = readSettings({});
  assert.equal(settings.aiProvider, 'mock'); assert.equal(settings.ai.enabled, false);
  assert.equal(readSettings({ AI_PROVIDER: 'cloudflare' }).ai.enabled, false);
  for (const env of [{ AI_ENABLED: '1' }, { AI_PROVIDER: 'cloudflare', AI_ENABLED: 'true' },
    { CLOUDFLARE_MODEL: '@cf/other/paid-model' }, { AI_DAILY_NEURON_LIMIT: '10000' },
    { AI_TIMEOUT_MS: '240001' }, { AI_MAX_CONCURRENT: '0' }, { AI_SESSION_DAILY_REQUEST_LIMIT: '-1' }])
    assert.throws(() => readSettings(env));
  assert.equal(estimatedNeurons(false), 131); assert.equal(estimatedNeurons(true), 137);
});

for (const language of ['en', 'de']) for (const type of Object.keys(giftInputs)) {
  test(`Cloudflare ${type}/${language}: multipart, one request, local lettering, footer, replay and protected download`, async t => {
    const cf = new FakeCloudflare();
    const f = await fixture(t, cf.options());
    const order = paid(f);
    const input = { ...giftInputs[type], language };
    const response = await create(f, order, input);
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json().gift.result;
    assert.equal(result.provider, 'cloudflare'); assert.equal(result.isDemo, false); assert.equal(result.type, type);
    assert.equal(cf.calls.length, 1); assert.equal(cf.calls[0].width, '512');
    assert.match(cf.calls[0].prompt, language === 'de' ? /Keramik, 350 ml/ : /Ceramic, 350 ml/);
    assert.ok(!cf.calls[0].prompt.includes('Test Alex')); assert.ok(!cf.calls[0].prompt.includes('Test Sam'));
    const raw = await new CloudflareGiftProvider(aiSettings(), new FakeCloudflare().fetch).generate({ ...input, product: products[0] });
    const product = language === 'de' ? { ...products[0], ...products[0].translations.de } : products[0];
    const lettered = await letterGiftImage(raw, { ...input, product });
    const image = await f.get(`/orders/${order.id}/gift/image`);
    await assertBrandedPng(image.rawPayload, lettered.image.bytes, language);
    const download = await f.get(`/orders/${order.id}/gift/download`);
    assert.deepEqual(download.rawPayload, image.rawPayload);
    assert.match(download.headers['content-disposition'], /attachment/);
    const foreign = await f.app.inject({ url: result.imageUrl, headers: { cookie: 'delight_session=' + 'f'.repeat(64) } });
    assert.equal(foreign.statusCode, 404);
    assert.deepEqual((await create(f, order, giftInputs['mini-comic'])).json(), response.json());
    assert.equal(cf.calls.length, 1);
    assert.equal(f.store.db.prepare("SELECT status FROM ai_attempts").get().status, 'COMPLETED');
    assert.equal(f.sandbox.calls.length, 0);
  });
}

test('photo requires Cloudflare-specific consent, strips EXIF, rotates/resizes below 512 and sends binary reference', async t => {
  const cf = new FakeCloudflare(); const f = await fixture(t, cf.options()); const order = paid(f);
  const photo = { consent: true, contentType: 'image/jpeg', data: (await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#f8ebda' } })
    .withExif({ IFD0: { Artist: 'PRIVATE-EXIF', Orientation: '6' } }).jpeg().toBuffer()).toString('base64') };
  const refused = await create(f, order, { ...giftInputs.caricature, photo });
  assert.equal(refused.json().code, 'PHOTO_CLOUDFLARE_CONSENT_REQUIRED'); assert.equal(cf.calls.length, 0);
  assert.equal(f.store.gift(order.id).status, 'AVAILABLE');
  const result = await create(f, order, { ...giftInputs.caricature, photo: { ...photo, cloudflareConsent: true } });
  assert.equal(result.statusCode, 200, result.body);
  const sent = cf.calls[0]; const metadata = await sharp(sent.photo).metadata();
  assert.equal(metadata.format, 'png'); assert.ok(metadata.width < 512 && metadata.height < 512);
  for (const key of ['exif', 'icc', 'iptc', 'xmp']) assert.equal(metadata[key], undefined);
  assert.equal(sent.photoName, 'reference.png'); assert.ok(!sent.photo.includes(Buffer.from('PRIVATE-EXIF')));
  assert.match(sent.prompt, /reference image 0/); assert.match(sent.prompt, /expressive features, stylized proportions/);
  assert.equal(f.store.db.prepare('SELECT estimated_neurons n FROM ai_attempts').get().n, 137);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM ai_attempts').all()).includes('PRIVATE'));
});

test('public demo cannot call the real provider even when AI is enabled; secrets stay backend-only', async t => {
  const cf = new FakeCloudflare(); const f = await fixture(t, cf.options());
  assert.equal((await f.app.inject('/api/gifts/demo/caricature.png')).statusCode, 200);
  const store = (await f.get('/store')).json();
  assert.deepEqual(store.gifts, { isDemo: false, provider: 'cloudflare', enabled: true });
  assert.ok(!JSON.stringify(store).includes('fake-cloudflare-test-token')); assert.equal(cf.calls.length, 0);
});

test('kill switch, invalid input and unpaid/foreign orders cannot dispatch or spend budget', async t => {
  const cf = new FakeCloudflare(); const options = cf.options({ enabled: false });
  const f = await fixture(t, options); const order = paid(f);
  assert.equal((await create(f, order)).json().code, 'AI_DISABLED');
  options.settings.ai.enabled = true;
  assert.equal((await create(f, order, { ...giftInputs.caricature, photo: { data: 'bad!', consent: true, cloudflareConsent: true, contentType: 'image/png' } })).statusCode, 400);
  assert.equal((await create(f, order, { ...giftInputs['greeting-card'], recipientName: '' })).statusCode, 400);
  assert.equal((await f.send(`/orders/${order.id}/gift`, giftInputs.caricature, { headers: { origin: f.settings.origin, cookie: 'delight_session=' + 'e'.repeat(64), 'content-type': 'application/json' } })).statusCode, 404);
  const unpaid = f.store.prepare(owner(f), randomUUID(), products[0]);
  assert.equal((await create(f, unpaid)).statusCode, 409);
  assert.equal(cf.calls.length, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ai_attempts').get().n, 0);
});

test('parallel requests across SQLite connections dispatch only once; different orders obey global concurrency', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-cf-parallel-')); const path = join(dir, 'test.sqlite');
  const cf = new FakeCloudflare(); let release, entered;
  cf.gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; }); cf.entered = entered;
  const f = await fixture(t, { ...cf.options({ maxConcurrent: 1 }), path });
  const other = await fixture(t, { ...cf.options({ maxConcurrent: 1 }), path, cookie: f.cookie });
  t.after(() => rm(dir, { recursive: true, force: true })); t.after(() => release());
  const order = paid(f); const next = paid(f);
  const first = create(f, order); await started;
  const repeats = await Promise.all(Array.from({ length: 8 }, () => create(other, order, giftInputs['greeting-card'])));
  assert.ok(repeats.every(r => r.statusCode === 202)); assert.equal(cf.calls.length, 1);
  assert.equal((await create(other, next)).json().code, 'AI_BUSY'); assert.equal(f.store.gift(next.id).status, 'AVAILABLE');
  release(); assert.equal((await first).statusCode, 200); assert.equal(cf.calls.length, 1);
});

for (const status of [400, 401, 403, 413, 422, 429]) {
  test(`explicit Cloudflare ${status} rejection preserves entitlement, counts reserved usage and never auto-retries`, async t => {
    const cf = new FakeCloudflare(); cf.status = status;
    const f = await fixture(t, cf.options()); const order = paid(f);
    const response = await create(f, order);
    assert.equal(response.json().code, status === 429 ? 'AI_PROVIDER_LIMIT' : 'AI_REJECTED');
    assert.equal(f.store.gift(order.id).status, 'AVAILABLE'); assert.equal(cf.calls.length, 1);
    assert.equal(f.store.db.prepare('SELECT status FROM ai_attempts').get().status, 'REJECTED');
    cf.status = 200;
    assert.equal((await create(f, order)).statusCode, 200); assert.equal(cf.calls.length, 2);
  });
}

for (const failure of ['timeout', 'network', 'server', 'invalid-base64', 'invalid-image', 'oversize', 'wrong-size', 'envelope']) {
  test(`${failure} holds the entitlement for review and blocks repeats/reload/provider switch`, async t => {
    const cf = new FakeCloudflare();
    if (failure === 'timeout') cf.hang = true;
    if (failure === 'network') cf.failure = true;
    if (failure === 'server') cf.status = 500;
    if (failure === 'invalid-base64') cf.json = { success: true, result: { image: '!!!!' } };
    if (failure === 'invalid-image') cf.json = { success: true, result: { image: Buffer.from('<svg/>').toString('base64') } };
    if (failure === 'oversize') cf.json = { success: true, result: { image: 'A'.repeat(17 * 1024 * 1024) } };
    if (failure === 'wrong-size') cf.bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'red' } }).png().toBuffer();
    if (failure === 'envelope') cf.json = { success: false, result: {} };
    const f = await fixture(t, cf.options({ timeoutMs: failure === 'timeout' ? 30 : 45_000 })); const order = paid(f);
    const response = await create(f, order);
    assert.equal(response.json().code, 'AI_REVIEW_REQUIRED', response.body);
    assert.equal((await f.get(`/orders/${order.id}/gift`)).json().gift.status, 'REVIEW');
    f.store.db.prepare('UPDATE gift_entitlements SET lock_until = 0').run();
    await create(f, order); await create(f, order, giftInputs['mini-comic']);
    await new Gifts(f.store, new MockGiftProvider()).create(owner(f), order.id, giftInputs.caricature);
    assert.equal(cf.calls.length, 1); assert.equal(f.store.gift(order.id).status, 'REVIEW');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM gift_images').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT status FROM ai_attempts').get().status, 'UNCERTAIN');
  });
}

for (const [options, code] of [[{ sessionDailyRequests: 1 }, 'AI_SESSION_LIMIT'], [{ dailyRequests: 1 }, 'AI_DAILY_LIMIT'], [{ dailyNeurons: 200 }, 'AI_DAILY_LIMIT']]) {
  test(`${code}/${JSON.stringify(options)} is durable and counts failures without using another entitlement`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'delight-cf-budget-')); const path = join(dir, 'test.sqlite');
    const cf = new FakeCloudflare(); cf.status = 429;
    const f = await fixture(t, { ...cf.options(options), path }); const order = paid(f);
    await create(f, order); await f.app.close();
    const next = await fixture(t, { ...cf.options(options), path, cookie: f.cookie });
    t.after(() => rm(dir, { recursive: true, force: true }));
    const second = paid(next); cf.status = 200;
    assert.equal((await create(next, second)).json().code, code);
    assert.equal(next.store.gift(second.id).status, 'AVAILABLE'); assert.equal(cf.calls.length, 1);
    next.store.db.prepare('UPDATE ai_attempts SET started_at = started_at - 86400000, deadline = deadline - 86400000').run();
    assert.equal((await create(next, second)).statusCode, 200); assert.equal(cf.calls.length, 2);
  });
}

test('three paid orders keep independent AI gifts and survive restart beside an old mock result', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-cf-restart-')); const path = join(dir, 'test.sqlite');
  const cf = new FakeCloudflare(); const f = await fixture(t, { ...cf.options(), path });
  const old = paid(f); const oldGift = await new MockGiftProvider().generate({ ...giftInputs.caricature, product: products[0] });
  saveLegacyGift(f.store, old.id, oldGift);
  const saved = [];
  for (const input of Object.values(giftInputs)) {
    const order = paid(f); const response = await create(f, order, input);
    assert.equal(response.statusCode, 200, response.body);
    saved.push({ order, result: response.json(), bytes: (await f.get(`/orders/${order.id}/gift/download`)).rawPayload });
  }
  assert.equal(cf.calls.length, 3); await f.app.close();
  const next = await fixture(t, { ...cf.options(), path, cookie: f.cookie });
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const { order, result, bytes } of saved) {
    assert.deepEqual((await create(next, order)).json(), result);
    assert.deepEqual((await next.get(`/orders/${order.id}/gift/download`)).rawPayload, bytes);
  }
  assert.deepEqual((await next.get(`/orders/${old.id}/gift/download`)).rawPayload, oldGift.image.bytes);
  assert.equal(cf.calls.length, 3); assert.equal(next.store.db.pragma('integrity_check', { simple: true }), 'ok');
});

test('crash recovery keeps a durable review hold; explicit operator release preserves budget and only allows a later manual request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-cf-review-')); const path = join(dir, 'test.sqlite');
  const cf = new FakeCloudflare(); cf.failure = true;
  const f = await fixture(t, { ...cf.options(), path }); const order = paid(f);
  await create(f, order);
  const attempt = f.store.db.prepare('SELECT * FROM ai_attempts').get();
  f.store.db.prepare("UPDATE ai_attempts SET status = 'STARTED', deadline = 0").run();
  await f.app.close();
  const next = await fixture(t, { ...cf.options(), path, cookie: f.cookie });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(next.store.gift(order.id).status, 'REVIEW'); await create(next, order); assert.equal(cf.calls.length, 1);
  assert.throws(() => releaseReviewedAttempt(next.store.db, order.id, 'wrong-attempt'));
  releaseReviewedAttempt(next.store.db, order.id, attempt.id);
  assert.equal(cf.calls.length, 1); assert.equal(next.store.gift(order.id).status, 'AVAILABLE');
  assert.equal(next.store.db.prepare('SELECT estimated_neurons FROM ai_attempts').get().estimated_neurons, attempt.estimated_neurons);
  cf.failure = false; assert.equal((await create(next, order)).statusCode, 200); assert.equal(cf.calls.length, 2);
  assert.throws(() => releaseReviewedAttempt(next.store.db, order.id, attempt.id));
});

test('lettering escapes markup, handles maximum German text, preserves art and adds real visible pixels', async () => {
  assert.equal(plainText('<b>A&B</b>'), '&lt;b&gt;A&amp;B&lt;/b&gt;');
  const cf = new FakeCloudflare();
  for (const type of ['greeting-card', 'mini-comic']) {
    const request = { ...giftInputs[type], language: 'de', recipientName: '<b>&'.repeat(20), characterName: 'Ä'.repeat(80), occasion: 'Ö'.repeat(120), wishes: 'Ü'.repeat(500), product: products[0] };
    const raw = { type, language: 'de', provider: 'cloudflare', isDemo: false, text: '', image: { bytes: await cf.image(), contentType: 'image/png', width: 512, height: 512 } };
    const result = await letterGiftImage(raw, request);
    assert.ok(result.image.height > 512);
    const band = await sharp(result.image.bytes).extract({ left: 0, top: type === 'mini-comic' ? 256 : 512, width: type === 'mini-comic' ? 256 : 512, height: 144 }).raw().toBuffer();
    assert.ok(band.some(byte => byte < 70));
    await assertBrandedPng((await brandGiftImage(result)).image.bytes, result.image.bytes, 'de');
  }
  assert.match(giftPrompt({ ...giftInputs.caricature, product: products[0] }), /fictional adult/);
  assert.match(giftPrompt({ ...giftInputs['mini-comic'], product: products[0] }), /exactly FOUR/);
  assert.equal(comicStory({ ...giftInputs['mini-comic'], product: products[0] }).length, 4);
});

test('AI audit records only order ID, mode, duration and outcome, even for private upstream errors', async t => {
  const cf = new FakeCloudflare(); cf.failure = true;
  const options = cf.options(); const f = await fixture(t, options); const order = paid(f); const events = [];
  const gifts = new Gifts(f.store, options.giftProvider, options.settings.ai, event => events.push(event));
  await assert.rejects(gifts.create(owner(f), order.id, { ...giftInputs.caricature, wishes: 'PRIVATE-WISHES' }), { code: 'AI_REVIEW_REQUIRED' });
  assert.deepEqual(Object.keys(events[0]).sort(), ['durationMs', 'mode', 'orderId', 'outcome']);
  assert.ok(!JSON.stringify(events).includes('PRIVATE')); assert.equal(events[0].outcome, 'UNCERTAIN');
});

test('global budget applies across different browser sessions; one exhausted session does not exhaust another', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-cf-sessions-')); const path = join(dir, 'test.sqlite');
  const cf = new FakeCloudflare();
  const a = await fixture(t, { ...cf.options({ sessionDailyRequests: 1, dailyRequests: 2 }), path });
  const b = await fixture(t, { ...cf.options({ sessionDailyRequests: 1, dailyRequests: 2 }), path });
  const c = await fixture(t, { ...cf.options({ sessionDailyRequests: 1, dailyRequests: 2 }), path });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await create(a, paid(a))).statusCode, 200);
  assert.equal((await create(a, paid(a))).json().code, 'AI_SESSION_LIMIT');
  assert.equal((await create(b, paid(b))).statusCode, 200);
  assert.equal((await create(c, paid(c))).json().code, 'AI_DAILY_LIMIT');
  assert.equal(cf.calls.length, 2);
});

test('additive v2 → v3 migration leaves existing order and gift bytes unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-cf-migration-')); const path = join(dir, 'test.sqlite');
  const f = await fixture(t, { path }); const order = paid(f);
  const gift = await new MockGiftProvider().generate({ ...giftInputs.caricature, product: products[0] });
  saveLegacyGift(f.store, order.id, gift);
  const before = f.store.get(order.id), beforeGift = f.store.gift(order.id);
  f.store.db.exec('DROP TABLE ai_attempts; PRAGMA user_version = 2');
  await f.app.close();
  const next = await fixture(t, { path, cookie: f.cookie });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(next.store.db.pragma('user_version', { simple: true }), 4);
  assert.deepEqual(next.store.get(order.id), before); assert.deepEqual(next.store.gift(order.id), beforeGift);
  assert.deepEqual((await next.get(`/orders/${order.id}/gift/download`)).rawPayload, gift.image.bytes);
  assert.equal(next.store.db.prepare('SELECT COUNT(*) n FROM ai_attempts').get().n, 0);
});

test('invalid uploaded photo buffers are also cleared, before any provider dispatch', async () => {
  const bytes = Buffer.from('private invalid photo data');
  await assert.rejects(withPreparedPhoto({ bytes, consent: true, contentType: 'image/png' }, () => assert.fail('invalid photo')), { code: 'PHOTO_INVALID' });
  assert.ok(bytes.every(value => value === 0));
});

test('late successful response after a timeout cannot save a gift or trigger another call', async t => {
  const cf = new FakeCloudflare(); let release;
  cf.gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, cf.options({ timeoutMs: 50 })); const order = paid(f);
  t.after(() => release());
  assert.equal((await create(f, order)).json().code, 'AI_REVIEW_REQUIRED');
  release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.store.gift(order.id).status, 'REVIEW');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM gift_images').get().n, 0);
  await create(f, order); assert.equal(cf.calls.length, 1);
});

test('database failure after successful inference rolls back image insertion and holds the right for review', async t => {
  const cf = new FakeCloudflare(); const f = await fixture(t, cf.options()); const order = paid(f);
  f.store.db.exec(`CREATE TRIGGER fail_gift_save BEFORE UPDATE OF status ON gift_entitlements
    WHEN NEW.status = 'GENERATED' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
  assert.equal((await create(f, order)).json().code, 'AI_REVIEW_REQUIRED');
  assert.equal(f.store.gift(order.id).status, 'REVIEW');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM gift_images').get().n, 0);
  await create(f, order); assert.equal(cf.calls.length, 1);
});

test('packaged offline review CLI requires explicit existing DB and authorisation; it never generates or erases usage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-cf-cli-')); const path = join(dir, 'test.sqlite');
  const cf = new FakeCloudflare(); cf.failure = true;
  const f = await fixture(t, { ...cf.options(), path }); const order = paid(f);
  await create(f, order); const attempt = f.store.db.prepare('SELECT * FROM ai_attempts').get();
  await f.app.close();
  const cli = (args, databasePath = path) => spawnSync(process.execPath, [fileURLToPath(new URL('../dist/review-ai-attempt.js', import.meta.url)), ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DATABASE_PATH: databasePath, AI_PROVIDER: 'mock', AI_ENABLED: 'false', NODE_ENV: 'test',
      APP_ORIGIN: 'http://127.0.0.1:5173', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' },
  });
  assert.equal(cli([order.id, attempt.id]).status, 1);
  const missing = join(dir, 'do-not-create.sqlite');
  assert.equal(cli([order.id], missing).status, 1); await assert.rejects(access(missing));
  const inspected = cli([order.id]); assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout)[0].status, 'UNCERTAIN');
  const released = cli([order.id, attempt.id, '--authorise-another-attempt']);
  assert.equal(released.status, 0, released.stderr); assert.equal(JSON.parse(released.stdout)[0].status, 'RELEASED');
  const next = await fixture(t, { path, cookie: f.cookie });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(next.store.gift(order.id).status, 'AVAILABLE'); assert.equal(cf.calls.length, 1);
  assert.equal(next.store.db.prepare('SELECT estimated_neurons n FROM ai_attempts').get().n, attempt.estimated_neurons);
  assert.equal(next.store.db.prepare('SELECT COUNT(*) n FROM gift_images').get().n, 0);
});
