import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createGiftProvider } from '../dist/gifts/provider.js';
import { withPreparedPhoto, PHOTO_MAX_BYTES } from '../dist/gifts/photo.js';
import { readSettings } from '../dist/config.js';
import { fixture } from './helpers.mjs';

const request = { type: 'caricature', product: { id: 'starry-night-puzzle', name: 'Starry Night Puzzle' }, language: 'en', wishes: 'A sunny morning' };
const image = (format = 'png') => sharp({ create: { width: 80, height: 40, channels: 3, background: '#e79973' } }).toFormat(format).toBuffer();

test('mock is the default, requires no credentials, returns the real local PNG and discloses the demo', async () => {
  const config = readSettings({});
  assert.equal(config.aiProvider, 'mock');
  const provider = createGiftProvider(config.aiProvider);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('AI network calls are forbidden'); };
  try {
    const result = await provider.generate(request);
    assert.equal(result.provider, 'mock');
    assert.equal(result.isDemo, true);
    assert.match(result.text, /not AI-generated/);
    assert.deepEqual(result.image.bytes, await readFile(new URL('../dist/assets/mock-caricature.png', import.meta.url)));
    const metadata = await sharp(result.image.bytes).metadata();
    assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 768);
    const german = await provider.generate({ ...request, language: 'de', wishes: 'Ein anderer Wunsch', product: { id: 'great-wave-puzzle', name: 'The Great Wave Puzzle' } });
    assert.equal(german.language, 'de'); assert.match(german.text, /Demobild/);
    assert.deepEqual(german.image.bytes, result.image.bytes);
    assert.throws(() => createGiftProvider('openai'), /not implemented/);
    await assert.rejects(provider.generate({ ...request, type: 'unknown' }), { code: 'GIFT_TYPE_UNAVAILABLE' });
    await assert.rejects(provider.generate({ ...request, wishes: 'x'.repeat(501) }), { code: 'INVALID_REQUEST' });
  } finally { globalThis.fetch = originalFetch; }
});

test('public mock image is a server file and never redeems a gift or calls PayPal', async t => {
  const f = await fixture(t);
  const response = await f.app.inject('/api/gifts/demo/caricature.png');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /image\/png/);
  assert.equal(response.headers['x-delight-demo'], 'true');
  assert.equal((await sharp(response.rawPayload).metadata()).width, 768);
  assert.equal(f.sandbox.calls.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM gift_entitlements').get().n, 0);
  assert.equal((await f.send('/gifts/generate', request)).statusCode, 404);
  assert.equal((await f.send('/photos', {})).statusCode, 404);
});

test('photos are optional; consent is mandatory and checked before any processing', async () => {
  assert.equal(await withPreparedPhoto(undefined, async photo => photo === undefined), true);
  let called = false;
  await assert.rejects(withPreparedPhoto({ bytes: await image(), contentType: 'image/png', consent: false }, async () => { called = true; }), { code: 'PHOTO_CONSENT_REQUIRED' });
  assert.equal(called, false);
});

test('JPEG, PNG and WebP are decoded, metadata stripped, and request buffers cleared without files', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const original = await sharp(await image()).withExif({ IFD0: { Artist: 'Private name', ImageDescription: 'Private location' } }).toFormat(format).toBuffer();
    assert.ok((await sharp(original).metadata()).exif);
    let temporary;
    await withPreparedPhoto({ bytes: original, contentType: `image/${format}`, consent: true }, async photo => {
      temporary = photo.bytes;
      assert.equal(photo.path, undefined);
      const clean = photo.bytes;
      const metadata = await sharp(clean).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
      assert.equal(metadata.icc, undefined); assert.equal(metadata.iptc, undefined);
      assert.ok(!clean.includes(Buffer.from('Private name')));
      assert.equal(photo.width, 80); assert.equal(photo.height, 40);
    });
    assert.ok(temporary.every(byte => byte === 0));
    assert.ok(original.every(byte => byte === 0));
  }
});

test('provider failure also clears the prepared photo buffer', async () => {
  let bytes;
  await assert.rejects(withPreparedPhoto({ bytes: await image(), contentType: 'image/png', consent: true }, async photo => {
    bytes = photo.bytes;
    throw new Error('provider failed');
  }), /provider failed/);
  assert.ok(bytes.every(byte => byte === 0));
});

test('photo validation rejects oversized, corrupt, disguised, unsupported and animated images', async () => {
  // Distinct frames prevent the encoder from collapsing this into a static WebP.
  const frames = Buffer.alloc(8 * 8 * 3);
  frames.fill(255, 0, 8 * 4 * 3);
  const animated = await sharp(frames, { raw: { width: 8, height: 8, channels: 3, pageHeight: 4 } }).webp().toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  const cases = [
    { bytes: Buffer.alloc(PHOTO_MAX_BYTES + 1), contentType: 'image/png', code: 'PHOTO_TOO_LARGE' },
    { bytes: Buffer.alloc(0), contentType: 'image/png' },
    { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), contentType: 'image/png' },
    { bytes: await image('jpeg'), contentType: 'image/png' },
    { bytes: (await image()).subarray(0, 20), contentType: 'image/png' },
    { bytes: await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'red' } }).png().toBuffer(), contentType: 'image/png' },
    { bytes: animated, contentType: 'image/webp' },
  ];
  for (const candidate of cases) {
    await assert.rejects(withPreparedPhoto({ ...candidate, consent: true }, async () => assert.fail('Invalid photo reached processing')), { code: candidate.code ?? 'PHOTO_INVALID' });
  }
});
