import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { GiftResult } from './provider.js';

// A separate footer preserves the entire provider image, without cropping or overlays.
// The static SVGs contain outlined text, so Windows and Linux need no installed fonts.
export async function brandGiftImage(result: GiftResult): Promise<GiftResult> {
  const image = sharp(result.image.bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
  const metadata = await image.metadata();
  const { width, height } = metadata;
  if (metadata.format !== 'png' || !width || !height || (metadata.pages ?? 1) !== 1)
    throw new Error('Gift branding requires a single PNG image');
  const footerHeight = Math.max(1, Math.round(width * 132 / 1200));
  if (width * (height + footerHeight) > 20_000_000)
    throw new Error('Gift exceeds the branded image pixel limit');
  const artwork = await readFile(new URL(`../assets/gift-footer-${result.language}.svg`, import.meta.url));
  const footer = await sharp(artwork).resize(width, footerHeight).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const original = await image.toColourspace('srgb').ensureAlpha().raw().timeout({ seconds: 15 }).toBuffer();
  // Stack decoded rows instead of compositing over the picture. In particular this avoids
  // premultiplied-alpha rounding of its translucent edges and preserves their RGBA pixels.
  const { data, info } = await sharp(Buffer.concat([original, footer]), {
    raw: { width, height: height + footerHeight, channels: 4 },
  }).png().timeout({ seconds: 15 }).toBuffer({ resolveWithObject: true });
  return { ...result, image: { bytes: data, contentType: 'image/png', width: info.width, height: info.height } };
}
