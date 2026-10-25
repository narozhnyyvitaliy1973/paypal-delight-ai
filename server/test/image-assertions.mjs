import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export async function assertBrandedPng(bytes, original, language) {
  const source = await sharp(original).metadata();
  const image = await sharp(bytes).metadata();
  assert.equal(image.format, 'png');
  assert.equal(image.width, source.width);
  assert.ok(image.height > source.height, 'Branding must be outside the original picture');
  assert.ok(image.height <= source.height + Math.ceil(source.width * 0.12), 'Footer must stay discreet');
  assert.equal(image.exif, undefined); assert.equal(image.xmp, undefined);
  const top = await sharp(bytes).extract({ left: 0, top: 0, width: source.width, height: source.height }).ensureAlpha().raw().toBuffer();
  assert.ok(top.equals(await sharp(original).ensureAlpha().raw().toBuffer()), 'Original pixels must remain intact');
  const artwork = await readFile(new URL(`../dist/assets/gift-footer-${language}.svg`, import.meta.url));
  const caption = language === 'de' ? 'Ein kleines Extra nach dem Bezahlen mit PayPal' : 'A little delight after paying with PayPal';
  assert.ok(artwork.toString().includes(`<title id="caption">${caption}</title>`));
  assert.ok(artwork.toString().includes('<desc id="brand">Delight AI</desc>'));
  assert.ok(!/<text\b|<image\b|<script\b|<foreignObject\b/.test(artwork.toString()), 'Self-contained vector artwork; no font or network dependency');
  const footerHeight = image.height - source.height;
  const footer = await sharp(bytes).extract({ left: 0, top: source.height, width: source.width, height: footerHeight }).ensureAlpha().raw().toBuffer();
  const expected = await sharp(artwork).resize(source.width, footerHeight).ensureAlpha().raw().toBuffer();
  assert.ok(footer.equals(expected), 'PNG must contain the correct language artwork');
  assert.ok(footer.some((value, index) => index % 4 !== 3 && value < 100), 'Footer must contain visible dark lettering');
  return image;
}

// A stage-3C persisted result, inserted only into isolated test databases.
export function saveLegacyGift(store, orderId, result) {
  const hash = createHash('sha256').update(result.image.bytes).digest('hex');
  const metadata = JSON.stringify({ type: result.type, language: result.language, provider: result.provider, isDemo: result.isDemo,
    text: result.text, width: result.image.width, height: result.image.height, createdAt: 1_700_000_000_000 });
  store.db.prepare('INSERT INTO gift_images (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING').run(hash, result.image.bytes);
  store.db.prepare("UPDATE gift_entitlements SET status = 'GENERATED', mode = ?, result_hash = ?, result_json = ? WHERE order_id = ?")
    .run(result.type, hash, metadata, orderId);
}
