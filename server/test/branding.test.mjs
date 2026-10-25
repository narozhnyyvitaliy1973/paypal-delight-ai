import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { brandGiftImage } from '../dist/gifts/branding.js';
import { assertBrandedPng } from './image-assertions.mjs';

test('branding handles arbitrary provider PNG sizes, keeps artwork and strips metadata without network or fonts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Branding must never call an external API');
  try {
    for (const [width, height, language] of [[1536, 1024, 'en'], [1024, 1536, 'de'], [800, 400, 'en']]) {
      const bytes = await sharp({ create: { width, height, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 0.5 } } })
        .withExif({ IFD0: { Artist: 'PRIVATE-METADATA' } }).png().toBuffer();
      const result = { type: 'caricature', language, provider: 'openai', isDemo: false, text: 'Synthetic test only; no provider call',
        image: { bytes, width: 1, height: 1, contentType: 'image/png' } };
      const branded = await brandGiftImage(result);
      const metadata = await assertBrandedPng(branded.image.bytes, bytes, language);
      assert.equal(branded.image.width, width); assert.equal(branded.image.height, metadata.height);
      assert.equal(branded.provider, result.provider); assert.equal(branded.isDemo, false);
      assert.equal(branded.text, result.text); assert.equal(result.image.bytes, bytes);
      assert.equal((await sharp(bytes).metadata()).height, height);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('branding rejects corrupt, non-PNG and extreme-aspect output before saving it', async () => {
  for (const bytes of [Buffer.from('invalid'),
    await sharp({create:{width:10,height:10,channels:3,background:'white'}}).jpeg().toBuffer(),
    await sharp({create:{width:16000,height:1,channels:3,background:'white'}}).png().toBuffer()]) {
    await assert.rejects(brandGiftImage({ language:'en', image:{bytes} }));
  }
});
