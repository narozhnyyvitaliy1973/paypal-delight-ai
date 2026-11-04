import sharp from 'sharp';
import { AppError } from '../errors.js';
import { CLOUDFLARE_MODEL, type AiSettings } from '../config.js';
import { validateGiftParameters, type GiftProvider, type GiftRequest, type GiftResult, type GiftGenerationContext } from './provider.js';
import { AI_IMAGE_SIZE, giftPrompt, PHOENIX_MODEL, PHOENIX_STEPS, safeComicFallbackPrompt } from './prompts.js';

export interface CloudflareFailure {
  mode: GiftRequest['type']; providerStatus: number | null; providerCodes: number[]; providerMessages: string[];
  model: string; fallback: boolean; operationId?: string; outcome: 'COMPLETED' | 'REJECTED' | 'UNCERTAIN';
  rayId?: string; promptCharacters: number; durationMs: number;
}

// Keep technical error descriptions, stripping echoed input, credentials and quoted values.
function safeErrorMessage(message: string, privateValues: string[]): string {
  for (const value of privateValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(value).join('[redacted]');
    message = message.split(JSON.stringify(value).slice(1, -1)).join('[redacted]');
  }
  return message
    .replace(/\b(?:input_value|authorization|api[_ -]?token)\s*[:=][^\r\n]*/gi, '[input omitted]')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '[quoted value]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9+/_=-]{64,}/g, '[encoded value]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 1000);
}

async function errorDetails(response: Response, privateValues: string[]): Promise<Pick<CloudflareFailure, 'providerCodes' | 'providerMessages'>> {
  const empty = { providerCodes: [], providerMessages: [] };
  if (!response.body) return empty;
  const reader = response.body.getReader();
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 1000);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) return empty;
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const errors: { code?: unknown; message?: unknown }[] = Array.isArray(data.errors) ? data.errors.slice(0, 8) : [];
    return {
      providerCodes: errors.map(entry => entry?.code).filter((code): code is number => Number.isSafeInteger(code)),
      providerMessages: errors.map(entry => entry?.message).filter((message): message is string => typeof message === 'string')
        .map(message => safeErrorMessage(message, privateValues)),
    };
  } catch { return empty; }
  finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class AiOutcomeUnknown extends AppError {
  constructor() { super(503, 'AI_REVIEW_REQUIRED', 'The AI outcome is uncertain. Your gift right is held for operator review; no automatic retry will run.'); }
}
// Only explicit rejections are retryable. 5xx, disconnects, invalid
// output and timeouts may already have used compute, so must remain under review.
export class AiRejected extends AppError {
  constructor(code = 'AI_REJECTED', status = 503, readonly fallbackAllowed = false) { super(status, code, 'Cloudflare rejected this request. Your gift right remains available.'); }
}

export class CloudflareGiftProvider implements GiftProvider {
  readonly name = 'cloudflare' as const;
  constructor(private settings: AiSettings, private fetcher: typeof fetch = fetch,
    private audit: (event: CloudflareFailure) => void = () => {}) {}

  async generate(request: GiftRequest, context?: GiftGenerationContext): Promise<GiftResult> {
    if (!this.settings.enabled) throw new AiRejected('AI_DISABLED');
    if (this.settings.model !== CLOUDFLARE_MODEL || !/^[a-f0-9]{32}$/i.test(this.settings.accountId) || !this.settings.apiToken)
      throw new AiRejected('AI_NOT_CONFIGURED');
    validateGiftParameters(request);
    if (request.photo && (request.photo.width >= 512 || request.photo.height >= 512))
      throw new AiRejected('PHOTO_INVALID', 400);
    // Both calls share the original time window. Never extend the render/entitlement lease.
    const deadline = Date.now() + this.settings.timeoutMs;
    try {
      return await this.run(request, CLOUDFLARE_MODEL, giftPrompt(request), this.settings.timeoutMs, context);
    } catch (error) {
      if (!(error instanceof AiRejected) || !error.fallbackAllowed || request.type !== 'mini-comic' || request.photo || !context) throw error;
      const prompt = safeComicFallbackPrompt(request);
      if (!prompt || Date.now() >= deadline) throw error;
      context.beforeFallback();
      return this.run(request, PHOENIX_MODEL, prompt, Math.max(1, deadline - Date.now()), context);
    }
  }

  private async run(request: GiftRequest, model: string, prompt: string, timeoutMs: number, context?: GiftGenerationContext): Promise<GiftResult> {
    const fallback = model === PHOENIX_MODEL;
    const form = new FormData();
    form.set('prompt', prompt);
    form.set('width', String(AI_IMAGE_SIZE));
    form.set('height', String(AI_IMAGE_SIZE));
    if (request.photo) form.set('input_image_0', new Blob([new Uint8Array(request.photo.bytes)], { type: 'image/png' }), 'reference.png');
    const controller = new AbortController();
    const started = Date.now();
    let providerStatus: number | null = null;
    let details: Pick<CloudflareFailure, 'providerCodes' | 'providerMessages'> = { providerCodes: [], providerMessages: [] };
    let rayId = '';
    let outcome: CloudflareFailure['outcome'] = 'UNCERTAIN';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // One dispatch per model; no transport retries or redirects.
      const operation = async () => {
        const response = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${this.settings.accountId}/ai/run/${model}`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.settings.apiToken}`, ...(fallback ? { 'Content-Type': 'application/json' } : {}) },
          body: fallback ? JSON.stringify({ prompt, width: AI_IMAGE_SIZE, height: AI_IMAGE_SIZE, num_steps: PHOENIX_STEPS }) : form,
          signal: controller.signal, redirect: 'error',
          // fetch supplies multipart/form-data AND its boundary.
        });
        providerStatus = response.status;
        rayId = response.headers.get('cf-ray') ?? '';
        if (!response.ok) {
          details = await errorDetails(response, [this.settings.apiToken, this.settings.accountId, prompt,
            request.wishes, request.recipientName ?? '', request.characterName ?? '', request.occasion ?? '']);
        }
        if ([400, 401, 403, 413, 422, 429].includes(response.status)) {
          // Strict allowlist: moderation rejection, or explicitly no capacity before inference.
          // Mixed/unknown codes, quota 3036, bad inputs and permissions never qualify.
          const fallbackAllowed = details.providerCodes.length > 0 && (
            (response.status === 400 && details.providerCodes.every(code => code === 3030)) ||
            (response.status === 429 && details.providerCodes.every(code => code === 3040)));
          throw new AiRejected(response.status === 429 ? 'AI_PROVIDER_LIMIT' : 'AI_REJECTED', response.status === 429 ? 429 : 503, fallbackAllowed);
        }
        if (!response.ok) throw new AiOutcomeUnknown();
        // Bound the response even when Content-Length is absent or dishonest.
        if (!response.body || Number(response.headers.get('content-length')) > 16 * 1024 * 1024) {
          await response.body?.cancel(); throw new AiOutcomeUnknown();
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 16 * 1024 * 1024) throw new AiOutcomeUnknown();
            chunks.push(value);
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
        let bytes = Buffer.concat(chunks);
        if (!fallback) {
          const json = JSON.parse(bytes.toString('utf8'));
          const encoded = json?.result?.image;
          if (json?.success !== true || typeof encoded !== 'string' || !encoded.length || encoded.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AiOutcomeUnknown();
          bytes = Buffer.from(encoded, 'base64');
          if (bytes.toString('base64') !== encoded) throw new AiOutcomeUnknown();
        }
        // Phoenix REST returns binary image bytes, unlike FLUX's JSON/base64 envelope.
        if (bytes.length > 12 * 1024 * 1024) throw new AiOutcomeUnknown();
        const image = sharp(bytes, { limitInputPixels: AI_IMAGE_SIZE ** 2, failOn: 'warning' });
        const metadata = await image.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1 ||
            metadata.width !== AI_IMAGE_SIZE || metadata.height !== AI_IMAGE_SIZE) throw new AiOutcomeUnknown();
        const clean = await image.rotate().toColourspace('srgb').png().timeout({ seconds: 10 }).toBuffer();
        outcome = 'COMPLETED';
        return { type: request.type, language: request.language, provider: this.name, isDemo: false,
          image: { bytes: clean, contentType: 'image/png' as const, width: AI_IMAGE_SIZE, height: AI_IMAGE_SIZE },
          text: request.language === 'de'
            ? 'Mit Cloudflare Workers AI erstellt. KI-Bilder können Ungenauigkeiten enthalten.'
            : 'Created with Cloudflare Workers AI. AI images may contain inaccuracies.',
        };
      };
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AiOutcomeUnknown()); }, timeoutMs);
      })]);
    } catch (error) {
      if (error instanceof AiRejected) { outcome = 'REJECTED'; throw error; }
      // Provider messages, prompts, tokens and response bodies never escape to logs/client.
      throw new AiOutcomeUnknown();
    } finally {
      clearTimeout(timer); controller.abort(); form.delete('input_image_0');
      this.audit({ mode: request.type, model, fallback, operationId: context?.operationId, outcome, providerStatus, ...details,
        ...(/^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/.test(rayId) ? { rayId } : {}),
        promptCharacters: prompt.length, durationMs: Date.now() - started });
    }
  }
}
