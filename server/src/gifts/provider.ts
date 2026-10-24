import { readFile } from 'node:fs/promises';
import { AppError } from '../errors.js';
import type { PreparedPhoto } from './photo.js';

export type GiftType = 'caricature' | 'greeting-card' | 'mini-comic';
export type GiftLanguage = 'en' | 'de';
export type ProviderName = 'mock' | 'openai';
export interface GiftRequest {
  type: GiftType;
  product: { id: string; name: string };
  language: GiftLanguage;
  wishes: string;
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

export class MockGiftProvider implements GiftProvider {
  readonly name = 'mock' as const;
  async generate(request: GiftRequest): Promise<GiftResult> {
    if (!['en', 'de'].includes(request.language) ||
        typeof request.wishes !== 'string' || request.wishes.length > 500 ||
        !request.product?.id || !request.product.name) {
      throw new AppError(400, 'INVALID_REQUEST', 'Invalid gift request.');
    }
    if (request.type !== 'caricature') {
      throw new AppError(422, 'GIFT_TYPE_UNAVAILABLE', 'Only the caricature demo is prepared.');
    }
    // Deliberately independent of photo/wishes. No network, secrets, SQLite or entitlement changes.
    return {
      type: request.type, language: request.language, provider: this.name, isDemo: true,
      image: {
        bytes: await readFile(new URL('../assets/mock-caricature.png', import.meta.url)),
        contentType: 'image/png', width: 768, height: 768,
      },
      text: request.language === 'de'
        ? 'Demobild — nicht KI-generiert oder personalisiert.'
        : 'Demo image — not AI-generated or personalised.',
    };
  }
}

export function createGiftProvider(name: ProviderName): GiftProvider {
  if (name === 'mock') return new MockGiftProvider();
  // A deliberate stop, never a silent fallback or a paid API call.
  throw new Error('AI_PROVIDER=openai is not implemented. Use AI_PROVIDER=mock.');
}
