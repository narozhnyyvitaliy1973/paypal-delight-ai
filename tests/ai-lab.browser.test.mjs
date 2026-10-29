import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import sharp from 'sharp';
import { fixture } from '../server/test/helpers.mjs';
import { FakeCloudflare } from '../server/test/cloudflare-helpers.mjs';

globalThis.fetch = () => { throw new Error('Real API calls forbidden in browser fixtures'); };
const token = 'a'.repeat(64);
test('private AI lab in the browser, without purchases or real providers', { timeout: 180_000 }, async t => {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const screenshots = mkdtempSync(join(tmpdir(), 'delight-lab-browser-'));
  t.after(() => {
    assert.equal(dirname(resolve(screenshots)), resolve(tmpdir()));
    rmSync(screenshots, { recursive: true, force: true });
  });
  async function setup(t, options = {}, language = 'en', authorised = true) {
    const closes = [];
    const f = await fixture({ after: fn => closes.push(fn) }, { ...options, settings: { ...options.settings, lab: { enabled: true, proxyToken: token } } });
    const backend = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const vite = await preview({ root: fileURLToPath(new URL('../client', import.meta.url)), configFile: fileURLToPath(new URL('../client/vite.config.ts', import.meta.url)),
      preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: backend, headers: authorised ? { 'x-delight-lab-token': token } : {} } } } });
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`; f.settings.origin = origin;
    const context = await browser.newContext({ locale: language === 'de' ? 'de-DE' : 'en-US', viewport: { width: language === 'de' ? 375 : 1440, height: 1000 } });
    t.after(async () => { await context.close(); await new Promise(resolve => vite.httpServer.close(resolve)); for(const close of closes) await close(); });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = []; const paymentRequests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if(new URL(r.url()).pathname.startsWith('/api/orders')) paymentRequests.push(r.url()); });
    await page.goto(origin + '/ai-lab'); return { ...f, page, context, origin, errors, paymentRequests };
  }
  for(const provider of ['mock', 'fake-cloudflare']) for(const language of ['en', 'de']) {
    await t.test(`${provider}/${language}: three modes, new tests, history, reload, downloads, zero purchases`, async t => {
      const cf = new FakeCloudflare(); const f = await setup(t, provider === 'mock' ? {} : cf.options(), language);
      const ids = [];
      for(const mode of ['caricature', 'greeting-card', 'mini-comic']) {
        if(ids.length) await f.page.getByTestId('lab-new').click();
        await f.page.getByTestId(`choose-${mode}`).click();
        if(mode === 'caricature') {
          assert.equal(await f.page.locator('input[type=file]').isDisabled(), true);
          assert.equal(await f.page.getByRole('checkbox').first().isChecked(), false);
        } else {
          await f.page.locator('.gift-fields input:not([readonly])').first().fill('Test Alex');
          if(mode === 'greeting-card') await f.page.locator('.gift-fields input:not([readonly])').nth(1).fill('Happy day');
        }
        await f.page.locator('textarea').fill('A sunny, friendly story');
        await f.page.getByTestId('create-gift').click(); await f.page.getByTestId('gift-result').waitFor();
        const id = new URL(f.page.url()).searchParams.get('run'); ids.push(id);
        const download = f.page.waitForEvent('download'); await f.page.getByTestId('gift-download').click();
        assert.equal((await sharp(await readFile(await (await download).path())).metadata()).format, 'png');
        await f.page.reload(); await f.page.getByTestId('gift-result').waitFor();
        assert.equal(await f.page.getByTestId('create-gift').count(), 0);
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      for(const id of ids) { await f.page.getByTestId(`lab-run-${id}`).click(); await f.page.waitForURL(url => url.searchParams.get('run') === id); await f.page.getByTestId('gift-result').waitFor(); }
      assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM gift_entitlements').get().n, 0);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ai_lab_runs').get().n, 3);
      assert.equal(cf.calls.length, provider === 'mock' ? 0 : 3);
      assert.deepEqual(f.paymentRequests, []); assert.deepEqual(f.errors, []);
      assert.match(await f.page.locator('.saved-title').innerText(), language === 'de' ? /Testhistorie/ : /test history/);
      assert.match(await f.page.locator('.footer-bottom').innerText(), provider === 'mock' ? /DEMO/ : /Cloudflare Workers AI/);
      await f.page.screenshot({ path: `${screenshots}/stage5-lab-${provider}-${language}.png`, fullPage: true, animations: 'disabled' });
    });
  }
  await t.test('uncertain test allows a new manual test, while reload never dispatches', async t => {
    const cf = new FakeCloudflare(); cf.failure = true; const f = await setup(t, cf.options());
    await f.page.getByTestId('choose-caricature').click(); await f.page.getByTestId('create-gift').click(); await f.page.getByTestId('lab-failed').waitFor();
    await f.page.reload(); await f.page.getByTestId('lab-failed').waitFor(); assert.equal(cf.calls.length, 1);
    cf.failure = false;
    await f.page.getByTestId('lab-new').click(); await f.page.getByTestId('choose-caricature').click();
    await f.page.getByTestId('create-gift').click(); await f.page.getByTestId('gift-result').waitFor(); assert.equal(cf.calls.length, 2);
  });
  await t.test('missing proxy authorisation hides forms and rejects direct access', async t => {
    const f = await setup(t, {}, 'en', false); await f.page.getByRole('alert').waitFor();
    assert.equal(await f.page.getByTestId('choose-caricature').count(), 0);
    assert.equal((await f.context.request.get(f.origin + '/api/ai-lab')).status(), 404);
  });
  await t.test('lost POST reply recovers the saved image and never issues another generation', async t => {
    const cf = new FakeCloudflare(); const f = await setup(t, cf.options());
    await f.page.route('**/api/ai-lab/runs', async route => { await route.fetch(); await route.abort(); });
    await f.page.getByTestId('choose-caricature').click(); await f.page.getByTestId('create-gift').click();
    await f.page.getByTestId('gift-result').waitFor(); await f.page.reload(); await f.page.getByTestId('gift-result').waitFor();
    assert.equal(cf.calls.length, 1); assert.equal(await f.page.getByTestId('create-gift').count(), 0);
  });
});
