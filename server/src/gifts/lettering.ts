import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import type { GiftRequest, GiftResult } from './provider.js';
import { comicStory } from './prompts.js';

const fontfile = fileURLToPath(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url));
// Pango markup is never supplied by users. Escape before rendering, including wishes.
export function plainText(value: string) {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
async function caption(text: string, width: number, height: number) {
  const rendered = await sharp({ text: {
    text: `<span foreground="#17283b">${plainText(text)}</span>`,
    font: 'Noto Sans 30', fontfile, width: width - 48, height: height - 32,
    align: 'centre', wrap: 'word-char', rgba: true,
  } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: '#fffdf8' } })
    .composite([{ input: rendered, gravity: 'centre' }]).png().toBuffer();
}

// Captions live in added space: the complete model artwork remains visible.
// Mock/legacy files are deliberately unchanged. No text-generation API is needed.
export async function letterGiftImage(result: GiftResult, request: GiftRequest): Promise<GiftResult> {
  if (result.isDemo || request.type === 'caricature') return result;
  const { width, height } = result.image;
  let data: Buffer;
  let outputHeight: number;
  if (request.type === 'greeting-card') {
    const greeting = request.language === 'de' ? `Für ${request.recipientName}` : `For ${request.recipientName}`;
    const text = `${greeting}\n${request.occasion}\n\n${request.wishes || (request.language === 'de' ? 'Ein kleiner Grund zum Lächeln!' : 'A little reason to smile!')}\n\n${request.product.name}`;
    outputHeight = height + 440;
    data = await sharp({ create: { width, height: outputHeight, channels: 4, background: '#fffdf8' } })
      .composite([{ input: result.image.bytes, top: 0, left: 0 }, { input: await caption(text, width, 440), top: height, left: 0 }])
      .png().toBuffer();
  } else {
    const panelWidth = Math.floor(width / 2), panelHeight = Math.floor(height / 2), captionHeight = 144;
    const panels: OverlayOptions[] = [];
    const story = comicStory(request);
    for (let i = 0; i < 4; i++) {
      const left = (i % 2) * panelWidth, top = Math.floor(i / 2) * (panelHeight + captionHeight);
      panels.push({ input: await sharp(result.image.bytes).extract({ left, top: Math.floor(i / 2) * panelHeight, width: panelWidth, height: panelHeight }).png().toBuffer(), left, top });
      panels.push({ input: await caption(story[i]!, panelWidth, captionHeight), left, top: top + panelHeight });
    }
    outputHeight = (panelHeight + captionHeight) * 2;
    data = await sharp({ create: { width, height: outputHeight, channels: 4, background: '#fffdf8' } }).composite(panels).png().toBuffer();
  }
  return { ...result, image: { bytes: data, contentType: 'image/png', width, height: outputHeight } };
}
