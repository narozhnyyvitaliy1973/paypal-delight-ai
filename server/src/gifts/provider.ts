import { readFile } from 'node:fs/promises';
import { AppError } from '../errors.js';
import type { PreparedPhoto } from './photo.js';
import type { AiSettings } from '../config.js';
import { CloudflareGiftProvider } from './cloudflare.js';

export type GiftType = 'caricature' | 'greeting-card' | 'mini-comic';
export type GiftLanguage = 'en' | 'de';
export type ProviderName = 'mock' | 'cloudflare' | 'openai';
export interface GiftParameters {
  type: GiftType;
  language: GiftLanguage;
  wishes: string;
  recipientName?: string;
  occasion?: string;
  characterName?: string;
}
export interface GiftRequest extends GiftParameters {
  product: { id: string; name: string; description?: string };
  // Only validated, metadata-free, request-scoped bytes; never the original upload.
  photo?: PreparedPhoto;
}
export interface GiftResult {
  type: GiftType;
  language: GiftLanguage;
  provider: ProviderName;
  isDemo: boolean;
  image: { bytes: Buffer; contentType: 'image/png'; width: number; height: number };
  text: string;
}
export interface GiftProvider {
  readonly name: ProviderName;
  generate(request: GiftRequest): Promise<GiftResult>;
}

export function validateGiftParameters(input: GiftParameters & { photo?: unknown }) {
  if (!['caricature', 'greeting-card', 'mini-comic'].includes(input.type))
    throw new AppError(400, 'GIFT_TYPE_UNAVAILABLE', 'Unknown gift type.');
  if (!['en', 'de'].includes(input.language) || typeof input.wishes !== 'string' || input.wishes.length > 500)
    throw new AppError(400, 'INVALID_REQUEST', 'Invalid gift request.');
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const valid = input.type === 'greeting-card'
    ? text(input.recipientName, 80) && text(input.occasion, 120) && input.characterName === undefined && input.photo === undefined
    : input.type === 'mini-comic'
      ? text(input.characterName, 80) && input.recipientName === undefined && input.occasion === undefined && input.photo === undefined
      : input.recipientName === undefined && input.occasion === undefined && input.characterName === undefined;
  if (!valid) throw new AppError(400, 'GIFT_PERSONALIZATION_INVALID', 'Check the fields for the selected gift type.');
}

const mockImages: Record<GiftType, { file: string; width: number; height: number }> = {
  caricature: { file: 'mock-caricature.png', width: 768, height: 768 },
  'greeting-card': { file: 'mock-greeting-card.png', width: 900, height: 1100 },
  'mini-comic': { file: 'mock-mini-comic.png', width: 1200, height: 900 },
};

export class MockGiftProvider implements GiftProvider {
  readonly name = 'mock' as const;
  async generate(request: GiftRequest): Promise<GiftResult> {
    validateGiftParameters(request);
    if (!request.product?.id || !request.product.name) {
      throw new AppError(400, 'INVALID_REQUEST', 'Invalid gift request.');
    }
    const asset = mockImages[request.type];
    // Each mode has a fixed illustration. Personalisation stays request-scoped; no network calls.
    return {
      type: request.type, language: request.language, provider: this.name, isDemo: true,
      image: {
        bytes: await readFile(new URL(`../assets/${asset.file}`, import.meta.url)),
        contentType: 'image/png', width: asset.width, height: asset.height,
      },
      text: request.language === 'de'
        ? 'Demobild — nicht KI-generiert oder personalisiert.'
        : 'Demo image — not AI-generated or personalised.',
    };
  }
}

export function createGiftProvider(name: ProviderName, settings?: AiSettings): GiftProvider {
  if (name === 'mock') return new MockGiftProvider();
  if (name === 'cloudflare') {
    if (!settings) throw new Error('Cloudflare settings are required.');
    return new CloudflareGiftProvider(settings);
  }
  // A deliberate stop, never a silent fallback or a paid API call.
  throw new Error('AI_PROVIDER=openai is not implemented. Use AI_PROVIDER=mock.');
}
