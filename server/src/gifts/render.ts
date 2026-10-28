import { AppError } from '../errors.js';
import { AI_RENDER_TIMEOUT_MS } from '../config.js';
import { products } from '../catalog.js';
import { withPreparedPhoto, PHOTO_MAX_BYTES } from './photo.js';
import { validateGiftParameters, type GiftParameters, type GiftProvider, type GiftRequest } from './provider.js';
import { brandGiftImage } from './branding.js';
import { letterGiftImage } from './lettering.js';

export interface CreateGift extends GiftParameters {
  photo?: { data: string; contentType: string; consent: boolean; cloudflareConsent?: boolean };
}

// Identical consent, image cleaning, prompting, lettering and branding for purchases and the private lab.
export async function renderGift(provider: GiftProvider, input: CreateGift, selectedProduct: GiftRequest['product'], beforeGenerate: (hasPhoto: boolean) => void) {
  validateGiftParameters(input);
  if (input.photo && input.photo.consent !== true)
    throw new AppError(400, 'PHOTO_CONSENT_REQUIRED', 'Separate photo consent is required.');
  if (input.photo && provider.name === 'cloudflare' && input.photo.cloudflareConsent !== true)
    throw new AppError(400, 'PHOTO_CLOUDFLARE_CONSENT_REQUIRED', 'Separate consent to send the cleaned photo to Cloudflare is required.');
  if (input.photo && (input.photo.data.length > Math.ceil(PHOTO_MAX_BYTES / 3) * 4 || input.photo.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.photo.data)))
    throw new AppError(400, 'PHOTO_INVALID', 'Invalid photo encoding.');
  const upload = input.photo ? { bytes: Buffer.from(input.photo.data, 'base64'), contentType: input.photo.contentType, consent: input.photo.consent } : undefined;
  const catalog = products.find(p => p.id === selectedProduct.id);
  const product = provider.name !== 'cloudflare' ? selectedProduct : { ...selectedProduct, description: catalog?.description ?? '',
    ...(input.language === 'de' && catalog ? { name: catalog.translations.de.name, description: catalog.translations.de.description } : {}) };
  const request = { type: input.type, product, language: input.language, wishes: input.wishes.trim(),
    recipientName: input.recipientName?.trim(), occasion: input.occasion?.trim(), characterName: input.characterName?.trim() };
  const result = await withPreparedPhoto(upload, async photo => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      beforeGenerate(Boolean(photo));
      return await Promise.race([provider.generate({ ...request, photo }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Gift timeout')), AI_RENDER_TIMEOUT_MS); })]);
    } finally { clearTimeout(timer); }
  });
  if (result.type !== input.type || result.language !== input.language) throw new Error('Provider returned a mismatched gift');
  return brandGiftImage(await letterGiftImage(result, request));
}
