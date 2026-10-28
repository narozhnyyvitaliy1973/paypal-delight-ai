import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readAiSettings } from '../dist/config.js';
import { CloudflareGiftProvider } from '../dist/gifts/cloudflare.js';

export const aiSettings = (overrides = {}) => ({ ...readAiSettings({ AI_PROVIDER: 'cloudflare', AI_ENABLED: 'true',
  CLOUDFLARE_ACCOUNT_ID: '1'.repeat(32), CLOUDFLARE_API_TOKEN: 'fake-cloudflare-test-token' }), ...overrides });
export const giftInputs = {
  caricature: { type: 'caricature', language: 'en', wishes: 'Sunshine and a friendly smile' },
  'greeting-card': { type: 'greeting-card', language: 'en', wishes: 'Have a wonderful day!', recipientName: 'Test Alex', occasion: 'Happy birthday' },
  'mini-comic': { type: 'mini-comic', language: 'en', wishes: 'A superhero morning', characterName: 'Test Sam' },
};
export class FakeCloudflare {
  calls = [];
  status = 200;
  json;
  failure = false;
  hang = false;
  gate;
  entered;
  bytes;
  async image() {
    return this.bytes ??= await sharp({ create: { width: 512, height: 512, channels: 3, background: '#e8b787' } }).png().toBuffer();
  }
  fetch = async (url, init) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/' + '1'.repeat(32) + '/ai/run/@cf/black-forest-labs/flux-2-klein-4b');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.equal(init.headers.Authorization, 'Bearer fake-cloudflare-test-token');
    assert.equal(new Headers(init.headers).has('content-type'), false);
    assert.ok(init.body instanceof FormData);
    const wire = new Request(url, init);
    assert.match(wire.headers.get('content-type'), /^multipart\/form-data; boundary=.+/);
    const form = await wire.formData();
    const reference = form.get('input_image_0');
    this.calls.push({ prompt: form.get('prompt'), width: form.get('width'), height: form.get('height'),
      keys: [...form.keys()], photo: reference ? Buffer.from(await reference.arrayBuffer()) : undefined,
      photoName: reference?.name, signal: init.signal });
    this.entered?.();
    if (this.hang) await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('simulated timeout')), { once: true }));
    if (this.gate) await this.gate;
    if (this.failure) throw new Error('private upstream request data must never leak');
    return new Response(JSON.stringify(this.json ?? { success: true, result: { image: (await this.image()).toString('base64') } }),
      { status: this.status, headers: { 'Content-Type': 'application/json' } });
  };
  options(overrides = {}) {
    const ai = aiSettings(overrides);
    return { settings: { aiProvider: 'cloudflare', ai }, giftProvider: new CloudflareGiftProvider(ai, this.fetch) };
  }
}
