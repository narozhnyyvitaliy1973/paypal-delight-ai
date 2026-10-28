import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fixture } from './helpers.mjs';
import { FakeCloudflare, giftInputs } from './cloudflare-helpers.mjs';
import { assertBrandedPng } from './image-assertions.mjs';
import { products } from '../dist/catalog.js';
import { readSettings } from '../dist/config.js';

globalThis.fetch = () => { throw new Error('Real network is forbidden in AI lab tests'); };
const token = 'a'.repeat(64);
const settings = { lab: { enabled: true, proxyToken: token } };
async function setup(t, cf = new FakeCloudflare(), options = {}, ai = {}) {
  const provider = cf.options(ai);
  const f = await fixture(t, { ...provider, ...options, settings: { ...provider.settings, ...settings, ...options.settings } });
  const headers = extra => ({ cookie: f.cookie, origin: f.settings.origin, 'content-type': 'application/json', 'x-delight-lab-token': token, ...extra });
  const post = (input = giftInputs.caricature, id = randomUUID(), extra = {}) => f.app.inject({ method: 'POST', url: '/api/ai-lab/runs', headers: headers(extra),
    payload: { ...input, requestId: id, productId: products[0].id } });
  const get = (path = '/api/ai-lab', extra = {}) => f.app.inject({ url: path, headers: headers(extra) });
  return { ...f, cf, post, getLab: get, headers };
}
test('lab disabled by default; enabling without proxy secret fails closed; budgets permit dozens', () => {
  const s = readSettings({});
  assert.equal(s.aiProvider, 'mock'); assert.equal(s.ai.enabled, false); assert.equal(s.lab.enabled, false);
  assert.equal(s.ai.dailyRequests, 50); assert.equal(s.ai.sessionDailyRequests, 50); assert.equal(s.ai.dailyNeurons, 8000);
  assert.throws(() => readSettings({ AI_LAB_ENABLED: 'true' }));
  assert.throws(() => readSettings({ AI_LAB_ENABLED: 'invalid' }));
  assert.throws(() => readSettings({ AI_DAILY_NEURON_LIMIT: '10000' }));
});
test('lab access requires enabled flag, private proxy token, browser session and same origin; responses contain no token', async t => {
  const f = await setup(t);
  for (const h of [{ 'x-delight-lab-token': '' }, { 'x-delight-lab-token': 'b'.repeat(64) }]) {
    assert.equal((await f.getLab('/api/ai-lab', h)).statusCode, 404);
    assert.equal((await f.post(undefined, undefined, h)).statusCode, 404);
  }
  assert.equal((await f.post(undefined, undefined, { origin: 'https://attacker.example' })).statusCode, 403);
  assert.equal((await f.post(undefined, undefined, { cookie: '' })).statusCode, 401);
  assert.equal(f.cf.calls.length, 0);
  const store = (await f.getLab('/api/store')).json();
  assert.equal(store.labAvailable, true); assert.ok(!JSON.stringify(store).includes(token));
  const off = await fixture(t);
  assert.equal((await off.get('/ai-lab', { headers: { cookie: off.cookie, 'x-delight-lab-token': token } })).statusCode, 404);
  const remote = await f.app.inject({ url: '/api/ai-lab', headers: f.headers(), remoteAddress: '192.0.2.5' });
  assert.equal(remote.statusCode, 404);
});
for (const language of ['en', 'de']) for (const type of Object.keys(giftInputs)) {
  test(`private ${type}/${language}: generate, branded PNG, replay, ownership; no orders or entitlements`, async t => {
    const f = await setup(t); const id = randomUUID();
    const input = { ...giftInputs[type], language };
    const first = await f.post(input, id); assert.equal(first.statusCode, 200);
    const run = first.json(); assert.equal(run.status, 'COMPLETED'); assert.equal(run.type, type);
    assert.equal(run.result.provider, 'cloudflare');
    const preview = await f.getLab(run.result.imageUrl); const download = await f.getLab(run.result.downloadUrl);
    assert.equal(preview.statusCode, 200); assert.deepEqual(preview.rawPayload, download.rawPayload);
    const unbranded = await sharp(download.rawPayload).extract({ left: 0, top: 0, width: 512, height: type === 'caricature' ? 512 : type === 'greeting-card' ? 952 : 800 }).png().toBuffer();
    await assertBrandedPng(download.rawPayload, unbranded, language);
    assert.equal((await f.post(giftInputs.caricature, id)).json().status, 'COMPLETED');
    assert.equal(f.cf.calls.length, 1);
    assert.equal((await f.getLab(run.result.downloadUrl, { cookie: `delight_session=${'f'.repeat(64)}` })).statusCode, 404);
    assert.equal((await f.post(input, id, { cookie: `delight_session=${'f'.repeat(64)}` })).statusCode, 404);
    for (const table of ['orders', 'gift_entitlements', 'gift_images', 'ai_attempts']) assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    assert.equal(f.sandbox.calls.length, 0);
  });
}
test('mock lab needs no AI credentials and makes no AI attempts', async t => {
  const f = await setup(t, new FakeCloudflare(), { settings: { aiProvider: 'mock', ai: readSettings({}).ai }, giftProvider: undefined });
  const r = (await f.post()).json(); assert.equal(r.status, 'COMPLETED'); assert.equal(r.result.provider, 'mock');
  assert.equal((await f.getLab()).json().usage.requests, 0); assert.equal(f.cf.calls.length, 0);
});
test('photo consents apply in lab too; validation errors consume neither budget nor test ID', async t => {
  const f = await setup(t); const data = (await f.cf.image()).toString('base64'); const id = randomUUID();
  const photo = { data, contentType: 'image/png', consent: false };
  assert.equal((await f.post({ ...giftInputs.caricature, photo }, id)).json().code, 'PHOTO_CONSENT_REQUIRED');
  assert.equal((await f.post({ ...giftInputs.caricature, photo: { ...photo, consent: true } }, id)).json().code, 'PHOTO_CLOUDFLARE_CONSENT_REQUIRED');
  assert.equal(f.cf.calls.length, 0); assert.equal((await f.getLab()).json().usage.requests, 0);
  assert.equal((await f.post({ ...giftInputs.caricature, photo: { ...photo, consent: true, cloudflareConsent: true } }, id)).json().status, 'COMPLETED');
  assert.ok(f.cf.calls[0].photo); assert.equal((await f.getLab()).json().usage.neurons, 137);
  assert.equal(f.store.db.prepare('PRAGMA table_info(ai_lab_runs)').all().some(c => /photo|prompt|wishes/.test(c.name)), false);
});
test('duplicate and parallel calls dispatch once; other IDs obey concurrency', async t => {
  const cf = new FakeCloudflare(); let release, entered;
  cf.gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { entered = resolve; }); cf.entered = entered;
  const f = await setup(t, cf, {}, { maxConcurrent: 1 }); const id = randomUUID();
  const first = f.post(undefined, id); await ready;
  try {
    assert.equal((await f.post(undefined, id)).json().status, 'STARTED');
    assert.equal((await f.post()).json().code, 'AI_BUSY');
    assert.equal(cf.calls.length, 1);
  } finally { release(); }
  assert.equal((await first).json().status, 'COMPLETED');
});
for (const failure of ['rejection', 'uncertain']) test(`${failure}: a new manual test works, same ID never replays, spent budget remains`, async t => {
  const cf = new FakeCloudflare(); if (failure === 'rejection') cf.status = 429; else cf.failure = true;
  const f = await setup(t, cf); const id = randomUUID();
  const r = (await f.post(undefined, id)).json(); assert.equal(r.status, failure === 'rejection' ? 'REJECTED' : 'UNCERTAIN');
  cf.status = 200; cf.failure = false;
  assert.equal((await f.post(undefined, id)).json().status, r.status); assert.equal(cf.calls.length, 1);
  assert.equal((await f.post()).json().status, 'COMPLETED'); assert.equal(cf.calls.length, 2);
  assert.equal((await f.getLab()).json().usage.requests, 2);
});
test('purchase and lab share budgets across sessions; test failure never consumes a purchase right', async t => {
  const f = await setup(t, new FakeCloudflare(), {}, { dailyRequests: 2 });
  const owner = createHash('sha256').update(f.cookie.split('=')[1]).digest('hex');
  const order = f.store.prepare(owner, randomUUID(), products[0]); f.store.created(order.id, 'TEST-ORDER', 'TEST-SELLER'); f.store.complete(order.id, 'TEST-CAPTURE');
  assert.equal((await f.send(`/orders/${order.id}/gift`, giftInputs.caricature)).statusCode, 200);
  assert.equal((await f.post()).json().status, 'COMPLETED');
  assert.equal((await f.post(undefined, undefined, { cookie: `delight_session=${'e'.repeat(64)}` })).json().code, 'AI_DAILY_LIMIT');
  assert.equal(f.cf.calls.length, 2);
  assert.equal(f.store.gift(order.id).status, 'COMPLETED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
});
test('lab budget also blocks a later purchase generation without losing its right', async t => {
  const f = await setup(t, new FakeCloudflare(), {}, { dailyNeurons: 200 });
  await f.post();
  const owner = createHash('sha256').update(f.cookie.split('=')[1]).digest('hex');
  const order = f.store.prepare(owner, randomUUID(), products[0]); f.store.created(order.id, 'TEST-ORDER', 'TEST-SELLER'); f.store.complete(order.id, 'TEST-CAPTURE');
  assert.equal((await f.send(`/orders/${order.id}/gift`, giftInputs.caricature)).json().code, 'AI_DAILY_LIMIT');
  assert.equal(f.store.gift(order.id).status, 'AVAILABLE'); assert.equal(f.cf.calls.length, 1);
});
test('restart preserves tests and budget; abandoned test expires without holding unrelated future tests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delight-lab-'));
  const path = join(dir, 'db.sqlite'); const f = await setup(t, new FakeCloudflare(), { path });
  const result = (await f.post()).json(); const cookie = f.cookie;
  const image = (await f.getLab(result.result.downloadUrl)).rawPayload;
  await f.app.close();
  const next = await setup(t, new FakeCloudflare(), { path, cookie });
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual((await next.getLab(result.result.downloadUrl)).rawPayload, image);
  assert.equal((await next.getLab()).json().usage.requests, 1);
  next.store.db.prepare("UPDATE ai_lab_runs SET status='STARTED', deadline=?, image=NULL, result_json=NULL WHERE id=?").run(Date.now()-1, result.id);
  assert.equal((await next.getLab(`/api/ai-lab/runs/${result.id}`)).json().status, 'UNCERTAIN');
  assert.equal((await next.post()).json().status, 'COMPLETED');
  assert.equal(next.store.db.pragma('integrity_check', { simple: true }), 'ok');
});
