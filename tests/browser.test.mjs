import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { MockGiftProvider } from '../server/dist/gifts/provider.js';
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview, createServer } from "vite";
import { fixture } from "../server/test/helpers.mjs";
import { assertBrandedPng, saveLegacyGift } from '../server/test/image-assertions.mjs';

// Browser and SDK interactions are simulated; real PayPal approval is a separate owner acceptance test.
const mockSdk = `
  customElements.define('paypal-button', class extends HTMLElement {
    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({mode:'open'}).innerHTML = '<button style="width:100%;height:46px;border:0;border-radius:4px;background:#ffc439;color:#003087;font-size:17px;font-weight:bold;cursor:pointer">PayPal</button>';
    }
  });
  window.paypal = { createInstance: async (options) => {
    if (!options.clientId || options.components[0] !== 'paypal-payments') throw Error('Invalid v6 setup');
    window.testSdkLocale = options.locale;
    return {
      findEligibleMethods: async (options) => ({ isEligible: (method) => options.currencyCode === 'EUR' && method === 'paypal' }),
      createPayPalOneTimePaymentSession: (callbacks) => ({
        hasReturned: () => new URLSearchParams(location.search).has('sdk_return'),
        resume: async () => {
          const orderId = new URLSearchParams(location.search).get('token');
          if (!orderId) throw Error('SDK return parameters were removed');
          await window.approveTestOrder(orderId);
          await callbacks.onApprove({orderId});
        },
        start: async (options, promise) => {
          if (options.presentationMode !== 'auto' || !(promise instanceof Promise)) throw Error('Invalid v6 start');
          const data = await promise;
          if (!data.orderId) throw Error('v6 expects an orderId object');
          if (window.testScenario === 'cancel') return callbacks.onCancel(data);
          if (window.testScenario === 'error') return callbacks.onError({code:'NETWORK_ERROR'});
          await window.approveTestOrder(data.orderId);
          await callbacks.onApprove(data);
        },
      }),
    };
  }};
`;

test(
  "browser checkout scenarios with simulated PayPal v6 and real application HTTP/SQLite",
  { timeout: 180_000 },
  async (t) => {
    const executablePath =
      process.env.BROWSER_EXECUTABLE_PATH ??
      [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ].find(existsSync);
    assert.ok(
      executablePath,
      "Set BROWSER_EXECUTABLE_PATH to an installed Chrome/Chromium/Edge executable.",
    );
    const browser = await chromium.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const screenshots = fileURLToPath(
      new URL("../.npm-cache", import.meta.url),
    );
    mkdirSync(screenshots, { recursive: true });

    async function pageFixture(t, scenario = "approve", options = {}) {
      const f = await fixture(t, options.fixture);
      const backend = await f.app.listen({ host: "127.0.0.1", port: 0 });
      const vite = await preview({
        root: fileURLToPath(new URL("../client", import.meta.url)),
        configFile: fileURLToPath(
          new URL("../client/vite.config.ts", import.meta.url),
        ),
        preview: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          proxy: { "/api": { target: backend } },
        },
      });
      const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
      f.settings.origin = origin;
      const context = await browser.newContext({
        viewport: { width: 1360, height: 1000 },
        locale: options.locale ?? 'en-US',
      });
      t.after(async () => {
        await context.close();
        await new Promise((resolve, reject) =>
          vite.httpServer.close((error) => (error ? reject(error) : resolve())),
        );
      });
      await context.addInitScript((mode) => {
        window.testScenario = mode;
      }, scenario);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("https://**/*", async (route) => {
        if (
          route.request().url() ===
          "https://www.sandbox.paypal.com/web-sdk/v6/core"
        ) {
          await route.fulfill({
            contentType: "application/javascript",
            body: mockSdk,
          });
        } else {
          await route.abort();
        }
      });
      await page.exposeFunction("approveTestOrder", (id) =>
        f.sandbox.approve(id),
      );
      await page.goto(origin + (options.path ?? '/'));
      if (!options.path && !options.noSdk) await page.getByRole("button", { name: "PayPal", exact: true }).waitFor();
      return { ...f, page, context, origin, errors };
    }
    const pay = (page) =>
      page.getByRole("button", { name: "PayPal", exact: true }).click();
    const success = (page) =>
      page.getByRole("heading", { name: "Celebrate Your Purchase!" });

    await t.test(
      "desktop/mobile store, approved purchase and reload restore the verified gift",
      async (t) => {
        const f = await pageFixture(t);
        assert.equal(await f.page.locator(".product-card").count(), 3);
        await f.page.screenshot({
          path: `${screenshots}/store-desktop.png`,
          fullPage: true,
        });
        await f.page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await f.page.screenshot({
          path: `${screenshots}/store-mobile.png`,
          fullPage: true,
        });
        await f.page.setViewportSize({ width: 1360, height: 1000 });
        await f.page
          .locator(".product-card")
          .nth(1)
          .getByRole("button")
          .click();
        await pay(f.page);
        await success(f.page).waitFor();
        assert.match(
          await f.page.locator(".celebration-copy").textContent(),
          /Weekend Tote/,
        );
        assert.equal(
          await f.page.locator(".gift-options button:disabled").count(),
          0,
        );
        await f.page.screenshot({
          path: `${screenshots}/purchase-success.png`,
          fullPage: true,
        });
        const url = f.page.url();
        await f.page.reload();
        await success(f.page).waitFor();
        assert.equal(f.sandbox.captureKeys.length, 1);
        assert.equal(
          f.store.db.prepare("SELECT COUNT(*) n FROM gift_entitlements").get()
            .n,
          1,
        );
        const stranger = await browser.newContext({ locale: 'en-US' });
        try {
          const page = await stranger.newPage();
          await page.route("https://**/*", (route) => route.abort());
          await page.goto(url);
          await page
            .getByText("Order not found in this browser session.")
            .waitFor();
          assert.equal(await success(page).count(), 0);
        } finally {
          await stranger.close();
        }
        assert.deepEqual(f.errors, []);
      },
    );
    await t.test("cancel callback cannot open success; retry creates a new order", async (t) => {
      const f = await pageFixture(t, "cancel");
      await pay(f.page);
      await f.page
        .getByText("Checkout cancelled. Your gift has not been unlocked.")
        .waitFor();
      assert.equal(await success(f.page).count(), 0);
      assert.equal(f.sandbox.captureKeys.length, 0);
      assert.deepEqual(f.errors, []);
      const firstOrder = [...f.sandbox.orders.keys()][0];
      await Promise.all([
        f.page.waitForResponse(response =>
          response.url().endsWith('/cancel') && response.status() === 200,
        ),
        pay(f.page),
      ]);
      assert.equal(f.sandbox.orders.size, 2);
      assert.notEqual([...f.sandbox.orders.keys()][1], firstOrder);
      assert.equal(f.sandbox.captureKeys.length, 0);
      assert.equal(await success(f.page).count(), 0);
    });
    await t.test(
      "declined capture gives actionable feedback without a gift",
      async (t) => {
        const f = await pageFixture(t);
        f.sandbox.captureIssue = "INSTRUMENT_DECLINED";
        await pay(f.page);
        await f.page.getByText(/Payment was declined/).waitFor();
        assert.equal(await success(f.page).count(), 0);
        assert.equal(
          f.store.db.prepare("SELECT COUNT(*) n FROM gift_entitlements").get()
            .n,
          0,
        );
        assert.deepEqual(f.errors, []);
      },
    );
    await t.test("SDK error keeps the order recoverable", async (t) => {
      const f = await pageFixture(t, "error");
      await pay(f.page);
      await f.page
        .getByText(
          "PayPal checkout was interrupted. Check your order before trying again.",
        )
        .waitFor();
      assert.equal(await success(f.page).count(), 0);
      assert.equal(f.sandbox.captureKeys.length, 0);
      assert.deepEqual(f.errors, []);
    });

    await t.test(
      "redirect return survives order restoration and resumes the SDK session",
      async (t) => {
        const f = await pageFixture(t, "error");
        await pay(f.page);
        await f.page
          .getByText(
            "PayPal checkout was interrupted. Check your order before trying again.",
          )
          .waitFor();
        const paypalId = [...f.sandbox.orders.keys()][0];
        await f.page.goto(
          `${f.page.url()}&sdk_return=approved&token=${paypalId}`,
        );
        await success(f.page).waitFor();
        assert.equal(f.sandbox.captureKeys.length, 1);
        assert.deepEqual(f.errors, []);
      },
    );
    await t.test(
      "lost capture response is recovered from the page without paying twice",
      async (t) => {
        const f = await pageFixture(t);
        f.sandbox.loseCapture = true;
        await pay(f.page);
        await f.page
          .getByText(
            "Payment confirmation was interrupted. Check or retry this same order.",
          )
          .waitFor();
        await f.page
          .getByRole("button", { name: "Check payment status" })
          .click();
        await success(f.page).waitFor();
        assert.equal(f.sandbox.captureKeys.length, 1);
        assert.deepEqual(f.errors, []);
      },
    );
    await t.test(
      "lost create response retries the existing purchase request",
      async (t) => {
        const f = await pageFixture(t);
        f.sandbox.loseCreate = true;
        await pay(f.page);
        await f.page.getByRole("alert").waitFor();
        await pay(f.page);
        await success(f.page).waitFor();
        assert.equal(f.sandbox.orders.size, 1);
        assert.equal(f.sandbox.captureKeys.length, 1);
        assert.deepEqual(f.errors, []);
      },
    );

    await t.test('German browser, manual English preference, refresh, legal navigation and checkout restoration', async t => {
      const f = await pageFixture(t, 'approve', { locale: 'de-DE' });
      const language = f.page.getByTestId('language-switch');
      assert.equal(await f.page.locator('html').getAttribute('lang'), 'de');
      assert.equal(await f.page.evaluate(() => window.testSdkLocale), 'de-DE');
      await f.page.getByRole('heading', { name: 'Morgensonne-Tasse' }).waitFor();
      await f.page.getByRole('heading', { name: 'Mit PayPal bezahlen' }).waitFor();
      assert.match(await f.page.locator('.checkout-total').innerText(), /18,00/);
      await f.page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await f.page.screenshot({ path: `${screenshots}/store-de-mobile.png`, fullPage: true });
      await f.page.setViewportSize({ width: 1360, height: 1000 });
      await pay(f.page);
      await f.page.getByRole('heading', { name: 'Feiere deinen Einkauf!' }).waitFor();
      assert.match(await f.page.locator('.celebration-copy').textContent(), /Morgensonne-Tasse/);
      assert.equal(await f.page.locator('.gift-options button:disabled').count(), 0);
      await f.page.getByText('Dein persönliches KI-Geschenk ist verfügbar.', { exact: true }).waitFor();
      await f.page.screenshot({ path: `${screenshots}/celebrate-de.png`, fullPage: true });
      await language.selectOption('en');
      await success(f.page).waitFor();
      await f.page.reload();
      await success(f.page).waitFor();
      assert.equal(await language.inputValue(), 'en');
      await f.page.getByRole('link', { name: 'Privacy Policy', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Privacy Policy', exact: true }).waitFor();
      assert.equal(await f.page.evaluate(() => typeof window.paypal), 'undefined');
      await language.selectOption('de');
      await f.page.getByRole('heading', { name: 'Datenschutzerklärung', exact: true }).waitFor();
      await f.page.getByRole('link', { name: 'Zurück zum Shop', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Morgensonne-Tasse' }).waitFor();
      // The store stays open for a new purchase; earlier paid orders have explicit links.
      await f.page.getByRole('link', { name: 'Zurück zu deinem letzten Geschenk' }).click();
      await f.page.getByRole('heading', { name: 'Feiere deinen Einkauf!' }).waitFor();
      assert.equal(f.sandbox.orders.size, 1);
      assert.equal(f.sandbox.captureKeys.length, 1);
      assert.deepEqual(f.errors, []);
    });

    await t.test('legal pages are bilingual, direct-linkable, and load no payment SDK or external fonts', async t => {
      const f = await pageFixture(t, 'approve', { locale: 'de-DE', path: '/legal' });
      const outgoing = [];
      f.page.on('request', r => { if (r.url().startsWith('https://')) outgoing.push(r.url()); });
      await f.page.reload();
      await f.page.getByRole('heading', { name: 'Impressum', exact: true }).waitFor();
      assert.match(await f.page.locator('.legal-page').textContent(), /VOR ÖFFENTLICHER BEREITSTELLUNG AUSFÜLLEN/);
      assert.equal(await f.page.evaluate(() => typeof window.paypal), 'undefined');
      assert.equal(await f.page.locator('paypal-button').count(), 0);
      await f.page.getByTestId('language-switch').selectOption('en');
      await f.page.getByRole('heading', { name: 'Legal Notice', exact: true }).waitFor();
      await f.page.getByRole('link', { name: 'Privacy Policy', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Privacy Policy', exact: true }).waitFor();
      assert.match(await f.page.locator('.legal-page').textContent(), /Photos and wishes are not retained/);
      await f.page.reload();
      assert.equal(await f.page.getByTestId('language-switch').inputValue(), 'en');
      assert.deepEqual(outgoing, []);
      assert.deepEqual(f.errors, []);
    });

    await t.test('unsupported browser language falls back to English', async t => {
      const f = await pageFixture(t, 'approve', { locale: 'fr-FR' });
      assert.equal(await f.page.locator('html').getAttribute('lang'), 'en');
      await f.page.getByRole('heading', { name: 'Daybreak Mug' }).waitFor();
    });

    for (const scenario of ['cancel', 'error', 'declined', 'pending']) {
      await t.test(`German ${scenario} feedback and live language switch`, async t => {
        const f = await pageFixture(t, ['cancel', 'error'].includes(scenario) ? scenario : 'approve', { locale: 'de-DE' });
        if (scenario === 'declined') f.sandbox.captureIssue = 'INSTRUMENT_DECLINED';
        if (scenario === 'pending') f.sandbox.captureStatus = 'PENDING';
        await pay(f.page);
        const de = { cancel: 'Zahlung abgebrochen.', error: 'Die PayPal-Zahlung wurde unterbrochen.', declined: 'Die Zahlung wurde abgelehnt.', pending: 'PayPal verarbeitet diese Zahlung noch.' };
        await f.page.getByText(de[scenario], { exact: false }).waitFor();
        await f.page.getByTestId('language-switch').selectOption('en');
        const en = { cancel: 'Checkout cancelled.', error: 'PayPal checkout was interrupted.', declined: 'Payment was declined.', pending: 'PayPal is still processing this payment.' };
        await f.page.getByText(en[scenario], { exact: false }).waitFor();
        assert.equal(await success(f.page).count(), 0);
        assert.deepEqual(f.errors, []);
      });
    }

    await t.test('backend errors use localised codes; unknown messages are not exposed', async t => {
      const f = await pageFixture(t, 'approve', { locale: 'de-DE' });
      await f.page.route('**/api/orders', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'ORIGIN_REJECTED', message: 'Raw server error must not be shown' }) }));
      await pay(f.page);
      await f.page.getByText('Öffne die Kasse über die konfigurierte Shop-Adresse.', { exact: true }).waitFor();
      await f.page.getByTestId('language-switch').selectOption('en');
      await f.page.getByText('Open checkout from the configured store address.', { exact: true }).waitFor();
      assert.ok(!(await f.page.locator('body').innerText()).includes('Raw server error'));
      assert.equal(f.sandbox.orders.size, 0);
    });

    await t.test('gift without photo: double submit, progress, PNG download, reload and return from store', async t => {
      let release, calls = 0;
      const gate = new Promise(resolve => { release = resolve; });
      t.after(() => release());
      const mock = new MockGiftProvider();
      const f = await pageFixture(t, 'approve', { fixture: { giftProvider: { name: 'mock', generate: async input => { calls++; await gate; return mock.generate(input); } } } });
      await pay(f.page); await success(f.page).waitFor();
      await f.page.getByTestId('choose-caricature').click();
      assert.equal(await f.page.getByLabel('Your purchased product').inputValue(), 'Daybreak Mug');
      assert.equal(await f.page.getByRole('checkbox').isChecked(), false);
      assert.equal(await f.page.locator('input[type=file]').isDisabled(), true);
      await f.page.getByLabel('Your wishes (optional)').fill('A bright morning');
      await f.page.screenshot({ path: `${screenshots}/gift-form-en.png`, fullPage: true });
      const requests = [];
      f.page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/gift')) requests.push(r); });
      await f.page.locator('.gift-form').evaluate(form => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await f.page.getByTestId('gift-progress').waitFor();
      assert.equal(await f.page.getByTestId('create-gift').isDisabled(), true);
      release();
      await f.page.getByTestId('gift-result').waitFor();
      assert.equal(requests.length, 1); assert.equal(calls, 1);
      const image = f.page.locator('.gift-image');
      await image.evaluate(img => img.decode());
      const downloaded = f.page.waitForEvent('download');
      await f.page.getByTestId('gift-download').click();
      const download = await downloaded;
      assert.match(download.suggestedFilename(), /^delight-caricature-[a-f0-9-]+\.png$/);
      const downloadedPng = await readFile(await download.path());
      await assertBrandedPng(downloadedPng, await readFile(new URL('../server/dist/assets/mock-caricature.png', import.meta.url)), 'en');
      const preview = await f.context.request.get(new URL(await f.page.locator('.gift-image').getAttribute('src'), f.origin).href);
      assert.deepEqual(await preview.body(), downloadedPng);
      await f.page.reload(); await f.page.getByTestId('gift-result').waitFor();
      await f.page.getByRole('button', { name: 'Back to the store' }).click();
      await f.page.getByRole('link', { name: 'Return to your latest gift' }).click();
      await f.page.getByTestId('gift-result').waitFor();
      await f.page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await f.page.screenshot({ path: `${screenshots}/gift-result-mobile.png`, fullPage: true });
      assert.equal(calls, 1); assert.equal(f.sandbox.captureKeys.length, 1);
      assert.deepEqual(f.errors, []);
    });

    await t.test('German photo flow, consent withdrawal, preview, metadata removal and bilingual result', async t => {
      const mock = new MockGiftProvider();
      let observed, clean;
      const f = await pageFixture(t, 'approve', { locale: 'de-DE', fixture: { giftProvider: { name: 'mock', generate: async input => {
        observed = input; clean = input.photo.bytes;
        assert.equal((await sharp(clean).metadata()).exif, undefined);
        return mock.generate(input);
      } } } });
      const outgoing = [];
      f.page.on('request', r => { if (r.url().startsWith('https://')) outgoing.push(r.url()); });
      await pay(f.page); await f.page.getByTestId('choose-caricature').click();
      await f.page.getByLabel('Deine Wünsche (optional)').fill('Ein heller Morgen');
      assert.equal(await f.page.getByLabel('Deine Wünsche (optional)').getAttribute('maxlength'), '500');
      const consent = f.page.getByRole('checkbox');
      assert.equal(await consent.isChecked(), false);
      const input = f.page.locator('input[type=file]');
      assert.equal(await input.isDisabled(), true);
      const photo = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#c97954' } }).withExif({ IFD0: { Artist: 'test private data' } }).jpeg().toBuffer();
      await consent.check();
      await input.setInputFiles({ name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: photo });
      await f.page.locator('.photo-preview').evaluate(img => img.decode());
      await consent.uncheck();
      assert.equal(await f.page.locator('.photo-preview').count(), 0);
      assert.equal(await input.inputValue(), '');
      await consent.check();
      await input.setInputFiles({ name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: photo });
      await f.page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await f.page.screenshot({ path: `${screenshots}/gift-form-de-mobile.png`, fullPage: true });
      await f.page.getByTestId('create-gift').click();
      await f.page.getByRole('heading', { name: 'Dein Geschenk ist fertig!' }).waitFor();
      assert.equal(observed.language, 'de'); assert.equal(observed.wishes, 'Ein heller Morgen');
      assert.ok(clean.every(byte => byte === 0));
      await f.page.getByTestId('language-switch').selectOption('en');
      await f.page.getByRole('heading', { name: 'Your gift is ready!' }).waitFor();
      await f.page.reload(); await f.page.getByTestId('gift-result').waitFor();
      assert.match(await f.page.locator('.gift-result').innerText(), /same prepared illustration/);
      // Changing the UI language never rewrites a saved German gift.
      const pendingDownload = f.page.waitForEvent('download');
      await f.page.getByTestId('gift-download').click();
      const download = await pendingDownload;
      const downloadedPng = await readFile(await download.path());
      await assertBrandedPng(downloadedPng, await readFile(new URL('../server/dist/assets/mock-caricature.png', import.meta.url)), 'de');
      const preview = await f.context.request.get(new URL(await f.page.locator('.gift-image').getAttribute('src'), f.origin).href);
      assert.deepEqual(await preview.body(), downloadedPng);
      assert.ok(outgoing.every(url => new URL(url).hostname === 'www.sandbox.paypal.com'));
      assert.deepEqual(f.errors, []);
    });

    await t.test('generation error keeps the right; localised retry creates one saved result', async t => {
      let calls = 0;
      const mock = new MockGiftProvider();
      const f = await pageFixture(t, 'approve', { fixture: { giftProvider: { name: 'mock', generate: async input => {
        if (++calls === 1) throw new Error('simulated provider failure'); return mock.generate(input);
      } } } });
      await pay(f.page); await f.page.getByTestId('choose-caricature').click();
      await f.page.getByTestId('create-gift').click();
      await f.page.getByText('Gift creation failed. Your right is still available. Please try again.', { exact: true }).waitFor();
      const id = new URL(f.page.url()).searchParams.get('order');
      assert.equal(f.store.gift(id).status, 'AVAILABLE');
      await f.page.getByTestId('language-switch').selectOption('de');
      await f.page.getByText('Die Geschenkerstellung ist fehlgeschlagen. Dein Anspruch bleibt verfügbar. Versuche es erneut.', { exact: true }).waitFor();
      await f.page.getByTestId('create-gift').click();
      await f.page.getByTestId('gift-result').waitFor();
      assert.equal(calls, 2); assert.equal(f.store.gift(id).status, 'COMPLETED');
      assert.deepEqual(f.errors, []);
    });

    await t.test('lost gift response recovers saved result without another generation', async t => {
      let calls = 0;
      const mock = new MockGiftProvider();
      const f = await pageFixture(t, 'approve', { fixture: { giftProvider: { name: 'mock', generate: async input => { calls++; return mock.generate(input); } } } });
      await pay(f.page); await f.page.getByTestId('choose-caricature').click();
      await f.page.route('**/api/orders/*/gift', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort('failed');
      });
      await f.page.getByTestId('create-gift').click();
      await f.page.getByTestId('gift-result').waitFor();
      assert.equal(calls, 1);
      await f.page.reload(); await f.page.getByTestId('gift-result').waitFor();
      assert.equal(calls, 1); assert.deepEqual(f.errors, []);
    });

    await t.test('refresh while generating restores progress and polls the saved result', async t => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      t.after(() => release());
      const mock = new MockGiftProvider();
      const f = await pageFixture(t, 'approve', { fixture: { giftProvider: { name: 'mock', generate: async input => { await gate; return mock.generate(input); } } } });
      await pay(f.page); await f.page.getByTestId('choose-caricature').click();
      await f.page.getByTestId('create-gift').click();
      await f.page.getByTestId('gift-progress').waitFor();
      await f.page.reload();
      await f.page.getByTestId('gift-progress').waitFor();
      release(); await f.page.getByTestId('gift-result').waitFor();
      assert.deepEqual(f.errors, []);
    });

    for (const mode of ['greeting-card', 'mini-comic']) {
      for (const language of ['en', 'de']) {
        await t.test(`${mode} in ${language}: required fields, preview, PNG, reload and cross-mode protection`, async t => {
          let observed, calls = 0, release;
          const gate = new Promise(resolve => { release = resolve; });
          t.after(() => release());
          const mock = new MockGiftProvider();
          const f = await pageFixture(t, 'approve', { locale: `${language}-${language === 'de' ? 'DE' : 'US'}`, fixture: { giftProvider: { name: 'mock', generate: async input => {
            calls++; observed = input; await gate; return mock.generate(input);
          } } } });
          const de = language === 'de', card = mode === 'greeting-card';
          await pay(f.page);
          await f.page.getByTestId(`choose-${mode}`).waitFor();
          assert.equal(await f.page.locator('.gift-options button:enabled').count(), 3);
          const outgoing = [], consoleErrors = [];
          f.page.on('request', r => { if (new URL(r.url()).origin !== f.origin) outgoing.push(r.url()); });
          f.page.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleErrors.push(message.text()); });
          await f.page.getByTestId(`choose-${mode}`).click();
          assert.equal(await f.page.locator('input[type=file]').count(), 0);
          const nameLabel = card ? (de ? 'Name der beschenkten Person' : 'Recipient name') : (de ? 'Name der Comicfigur' : 'Character name');
          const name = f.page.getByLabel(nameLabel, { exact: true });
          await f.page.getByTestId('create-gift').click();
          assert.equal(calls, 0);
          assert.equal(await name.evaluate(input => input.validity.valueMissing), true);
          assert.equal(await name.getAttribute('maxlength'), '80');
          await name.fill('   ');
          if (card) await f.page.getByLabel(de ? 'Anlass' : 'Occasion', { exact: true }).fill('Birthday');
          await f.page.getByTestId('create-gift').click();
          await f.page.getByRole('alert').waitFor();
          assert.equal(calls, 0);
          await name.fill('Alex');
          const wishesLabel = card ? (de ? 'Deine Wünsche (optional)' : 'Your wishes (optional)') : (de ? 'Wünsche zur Handlung (optional)' : 'Story wishes (optional)');
          await f.page.getByLabel(wishesLabel, { exact: true }).fill('A tiny adventure');
          await f.page.setViewportSize(de ? { width: 390, height: 844 } : { width: 1360, height: 1000 });
          assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await f.page.screenshot({ path: `${screenshots}/${mode}-form-${language}.png`, fullPage: true });
          await f.page.getByTestId('create-gift').click();
          await f.page.getByTestId('gift-progress').waitFor();
          assert.equal(await f.page.getByTestId('change-gift-mode').isDisabled(), true);
          assert.equal(await f.page.getByTestId('create-gift').isDisabled(), true);
          // Both new modes recover a generation in progress after a real page reload.
          await f.page.reload(); await f.page.getByTestId('gift-progress').waitFor();
          release(); await f.page.getByTestId('gift-result').waitFor();
          assert.equal(observed.type, mode); assert.equal(observed.language, language);
          assert.equal(observed.wishes, 'A tiny adventure');
          assert.deepEqual(observed.product, { id: 'daybreak-mug', name: 'Daybreak Mug' });
          assert.equal(observed.photo, undefined);
          assert.equal(observed[card ? 'recipientName' : 'characterName'], 'Alex');
          if (card) assert.equal(observed.occasion, 'Birthday');
          assert.match(await f.page.getByTestId('gift-mode').innerText(), new RegExp(card ? (de ? 'Grußkarte' : 'Greeting Card') : (de ? 'Mini-Comic' : 'Mini Comic')));
          assert.match(await f.page.getByTestId('gift-mode').innerText(), /DEMO/);
          await f.page.locator('.gift-image').evaluate(image => image.decode());
          const pendingDownload = f.page.waitForEvent('download');
          await f.page.getByTestId('gift-download').click();
          const download = await pendingDownload;
          assert.match(download.suggestedFilename(), new RegExp(`^delight-${mode}-[a-f0-9-]+\\.png$`));
          const downloadedPng = await readFile(await download.path());
          await assertBrandedPng(downloadedPng, await readFile(new URL(`../server/dist/assets/mock-${mode}.png`, import.meta.url)), language);
          const preview = await f.context.request.get(new URL(await f.page.locator('.gift-image').getAttribute('src'), f.origin).href);
          assert.deepEqual(await preview.body(), downloadedPng);
          await f.page.reload(); await f.page.getByTestId('gift-result').waitFor();
          assert.equal(await f.page.getByTestId('language-switch').inputValue(), language);
          assert.equal(await f.page.locator('.gift-options').count(), 0);
          assert.equal(await f.page.getByTestId('change-gift-mode').count(), 0);
          const id = new URL(f.page.url()).searchParams.get('order');
          const saved = f.store.gift(id);
          const replay = await f.page.evaluate(async id => {
            const response = await fetch(`/api/orders/${id}/gift`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'caricature', language: 'en', wishes: 'Another gift?' }),
            });
            return { status: response.status, order: await response.json() };
          }, id);
          assert.equal(replay.status, 200); assert.deepEqual(replay.order.gift, saved);
          assert.equal(calls, 1); assert.equal(f.sandbox.captureKeys.length, 1);
          await f.page.screenshot({ path: `${screenshots}/${mode}-result-${language}.png`, fullPage: true });
          assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          // Reloading the store still loads its existing PayPal SDK; no AI or other external requests.
          assert.ok(outgoing.every(url => url === 'https://www.sandbox.paypal.com/web-sdk/v6/core'));
          assert.deepEqual(consoleErrors, []); assert.deepEqual(f.errors, []);
        });
      }
    }

    await t.test('stage-3C unbranded gifts still preview and download unchanged after reload', async t => {
      const f = await pageFixture(t);
      const mock = new MockGiftProvider();
      for (const type of ['caricature', 'greeting-card', 'mini-comic']) {
        await pay(f.page); await success(f.page).waitFor();
        const id = new URL(f.page.url()).searchParams.get('order');
        const input = { type, language:'en', wishes:'', recipientName: type === 'greeting-card' ? 'Demo' : undefined,
          occasion: type === 'greeting-card' ? 'Demo' : undefined, characterName: type === 'mini-comic' ? 'Demo' : undefined,
          product: { id:'daybreak-mug', name:'Daybreak Mug' } };
        const original = await mock.generate(input);
        saveLegacyGift(f.store, id, original);
        await f.page.reload(); await f.page.getByTestId('gift-result').waitFor();
        await f.page.locator('.gift-image').evaluate(image=>image.decode());
        assert.equal(await f.page.locator('.gift-image').evaluate(image=>image.naturalHeight), original.image.height);
        const preview = await f.context.request.get(new URL(await f.page.locator('.gift-image').getAttribute('src'), f.origin).href);
        assert.deepEqual(await preview.body(), original.image.bytes);
        const pendingDownload = f.page.waitForEvent('download');
        await f.page.getByTestId('gift-download').click();
        assert.deepEqual(await readFile(await (await pendingDownload).path()), original.image.bytes);
        await f.page.getByRole('button', {name:/Back to the store/}).click();
        await f.page.getByRole('button', { name:'PayPal', exact:true }).waitFor();
      }
      assert.deepEqual(f.errors, []);
    });

    await t.test('switching modes discards photo and names; failed comic can be retried as a card', async t => {
      let calls = 0, observed;
      const mock = new MockGiftProvider();
      const f = await pageFixture(t, 'approve', { fixture: { giftProvider: { name: 'mock', generate: async input => {
        observed = input; if (++calls === 1) throw new Error('provider unavailable'); return mock.generate(input);
      } } } });
      await pay(f.page); await f.page.getByTestId('choose-caricature').click();
      await f.page.getByRole('checkbox').check();
      await f.page.locator('input[type=file]').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: await readFile(new URL('../server/dist/assets/mock-caricature.png', import.meta.url)) });
      await f.page.getByTestId('change-gift-mode').click();
      await f.page.getByTestId('choose-mini-comic').click();
      await f.page.getByLabel('Character name', { exact: true }).fill('Alex');
      await f.page.getByTestId('create-gift').click();
      await f.page.getByText('Gift creation failed. Your right is still available. Please try again.', { exact: true }).waitFor();
      assert.equal(observed.photo, undefined);
      const id = new URL(f.page.url()).searchParams.get('order');
      assert.equal(f.store.gift(id).status, 'AVAILABLE');
      await f.page.getByTestId('change-gift-mode').click();
      await f.page.getByTestId('choose-greeting-card').click();
      await f.page.getByLabel('Recipient name', { exact: true }).fill('Sam');
      await f.page.getByLabel('Occasion', { exact: true }).fill('Thank you');
      await f.page.getByTestId('create-gift').click();
      await f.page.getByTestId('gift-result').waitFor();
      assert.equal(observed.characterName, undefined); assert.equal(observed.photo, undefined);
      assert.equal(f.store.gift(id).result.type, 'greeting-card');
      assert.equal(calls, 2); assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM gift_images').get().n, 1);
      assert.deepEqual(f.errors, []);
    });

    await t.test('three consecutive purchases in one browser have independent gifts after reload', async t => {
      const f = await pageFixture(t);
      const saved = [];
      for (const [index, type] of ['caricature', 'greeting-card', 'mini-comic'].entries()) {
        if (index > 0) {
          if (index === 1) await f.page.getByRole('button', { name: 'Back to the store' }).click();
          else await f.page.locator('.brand').click();
          await f.page.getByRole('button', { name: 'PayPal', exact: true }).waitFor();
        }
        await f.page.locator('.product-card').nth(index).getByRole('button').click();
        await pay(f.page);
        await f.page.getByTestId(`choose-${type}`).waitFor();
        const id = new URL(f.page.url()).searchParams.get('order');
        assert.ok(!saved.some(order => order.id === id));
        assert.equal(f.store.get(id).status, 'COMPLETED');
        assert.equal(f.store.gift(id).status, 'AVAILABLE');
        assert.equal(await f.page.evaluate(() => sessionStorage.getItem('delight-checkout')), null);
        await f.page.getByTestId(`choose-${type}`).click();
        if (type === 'greeting-card') {
          await f.page.getByLabel('Recipient name', { exact: true }).fill('Alex');
          await f.page.getByLabel('Occasion', { exact: true }).fill('Thank you');
        }
        if (type === 'mini-comic') await f.page.getByLabel('Character name', { exact: true }).fill('Sam');
        await f.page.getByTestId('create-gift').click();
        await f.page.getByTestId('gift-result').waitFor();
        const gift = f.store.gift(id);
        assert.equal(gift.result.type, type);
        saved.push({ id, gift });
        if (index > 0) { await f.page.reload(); await f.page.getByTestId('gift-result').waitFor(); }
        assert.equal(f.store.gift(id).result.type, type);
      }
      assert.equal(f.sandbox.captureKeys.length, 3);
      assert.equal(new Set(saved.map(({ id }) => f.store.get(id).owner_hash)).size, 1);
      await f.page.goto(f.origin);
      await f.page.getByTestId('purchase-history').locator('summary').click();
      await f.page.getByTestId('purchase-history').screenshot({ path: `${screenshots}/purchase-history-en.png` });
      await f.page.setViewportSize({ width: 390, height: 844 });
      await f.page.getByTestId('language-switch').selectOption('de');
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await f.page.getByTestId('purchase-history').screenshot({ path: `${screenshots}/purchase-history-de-mobile.png` });
      await f.page.getByTestId('language-switch').selectOption('en');
      for (const { id, gift } of saved) {
        await f.page.goto(f.origin);
        await f.page.getByTestId('purchase-history').locator('summary').click();
        assert.equal(await f.page.locator('.purchase-history li').count(), 3);
        await f.page.getByTestId(`purchase-${id}`).click();
        await f.page.getByTestId('gift-result').waitFor();
        assert.equal(new URL(f.page.url()).searchParams.get('order'), id);
        assert.deepEqual(f.store.gift(id), gift);
        assert.match(await f.page.locator('.gift-image').getAttribute('src'), new RegExp(id));
      }
      assert.deepEqual(f.errors, []);
    });

    await t.test('opening an old gift never rewrites a newer unfinished checkout', async t => {
      const f = await pageFixture(t);
      await pay(f.page); await f.page.getByTestId('choose-caricature').waitFor();
      const first = new URL(f.page.url()).searchParams.get('order');
      await f.page.getByRole('button', { name: 'Back to the store' }).click();
      await f.page.evaluate(() => { window.testScenario = 'error'; });
      await pay(f.page);
      await f.page.getByText('PayPal checkout was interrupted.', { exact: false }).waitFor();
      const active = await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('delight-checkout')));
      assert.notEqual(active.orderId, first);
      await f.page.goto(`${f.origin}/?order=${first}`);
      await f.page.getByTestId('choose-caricature').waitFor();
      assert.deepEqual(await f.page.evaluate(() => JSON.parse(sessionStorage.getItem('delight-checkout'))), active);
      await f.page.getByRole('button', { name: 'Back to the store' }).click();
      await f.page.reload();
      await f.page.locator('.order-reference').filter({ hasText: active.orderId }).waitFor();
      assert.equal(new URL(f.page.url()).searchParams.get('order'), active.orderId);
      await pay(f.page); await f.page.getByTestId('choose-greeting-card').waitFor();
      assert.equal(new URL(f.page.url()).searchParams.get('order'), active.orderId);
      assert.equal(f.sandbox.orders.size, 2);
    });

    await t.test('legacy completed recovery cannot hijack a fresh checkout; all paid rights remain in history', async t => {
      const f = await pageFixture(t);
      const requests = [];
      f.page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/orders')) requests.push(r.postDataJSON()); });
      await pay(f.page); await f.page.getByTestId('choose-caricature').waitFor();
      const oldId = new URL(f.page.url()).searchParams.get('order');
      await f.page.evaluate(({ id, attempt }) => {
        sessionStorage.setItem('delight-checkout', JSON.stringify({ ...attempt, orderId: id }));
        sessionStorage.setItem('delight-last-gift-order', id);
      }, { id: oldId, attempt: requests[0] });
      await f.page.goto(f.origin);
      await f.page.getByRole('button', { name: 'PayPal', exact: true }).waitFor();
      assert.equal(new URL(f.page.url()).searchParams.get('order'), null);
      assert.equal(await f.page.evaluate(() => sessionStorage.getItem('delight-checkout')), null);
      await pay(f.page); await f.page.getByTestId('choose-mini-comic').waitFor();
      const newId = new URL(f.page.url()).searchParams.get('order');
      assert.notEqual(newId, oldId); assert.notEqual(requests[0].requestId, requests[1].requestId);
      assert.equal(f.store.gift(oldId).status, 'AVAILABLE');
      assert.equal(f.store.gift(newId).status, 'AVAILABLE');
      await f.page.reload(); await f.page.getByTestId('choose-mini-comic').waitFor();
      assert.equal(new URL(f.page.url()).searchParams.get('order'), newId);
      await f.page.getByRole('button', { name: 'Back to the store' }).click();
      await f.page.getByTestId('purchase-history').locator('summary').click();
      assert.equal(await f.page.locator('.purchase-history li').count(), 2);
      await f.page.getByTestId('language-switch').selectOption('de');
      await f.page.getByText('Deine Einkäufe & Geschenke', { exact: false }).waitFor();
      await f.page.getByTestId(`purchase-${newId}`).click();
      await f.page.getByTestId('choose-mini-comic').waitFor();
      assert.equal(new URL(f.page.url()).searchParams.get('order'), newId);
      assert.equal(f.sandbox.captureKeys.length, 2);
      assert.deepEqual(f.errors, []);
    });

    await t.test('late recovery from a previous gift cannot replace the next paid order', async t => {
      const f = await pageFixture(t);
      await pay(f.page); await f.page.getByTestId('choose-caricature').click();
      const firstId = new URL(f.page.url()).searchParams.get('order');
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      t.after(() => release());
      await f.page.route(`**/api/orders/${firstId}/gift`, async route => {
        const response = await route.fetch();
        if (route.request().method() === 'POST') return route.abort('failed');
        entered(); await gate; await route.fulfill({ response });
      });
      await f.page.getByTestId('create-gift').click();
      await started;
      assert.equal(f.store.gift(firstId).status, 'COMPLETED');
      await f.page.getByRole('button', { name: 'Back to the store' }).click();
      await pay(f.page); await f.page.getByTestId('choose-greeting-card').waitFor();
      const secondId = new URL(f.page.url()).searchParams.get('order');
      assert.notEqual(secondId, firstId);
      release();
      await f.page.waitForLoadState('networkidle');
      assert.equal(await f.page.getByTestId('gift-result').count(), 0);
      assert.equal(await f.page.getByTestId('choose-greeting-card').isVisible(), true);
      assert.equal(new URL(f.page.url()).searchParams.get('order'), secondId);
      assert.equal(f.store.gift(secondId).status, 'AVAILABLE');
      await f.page.reload(); await f.page.getByTestId('choose-greeting-card').waitFor();
      assert.equal(f.sandbox.captureKeys.length, 2);
      assert.deepEqual(f.errors, []);
    });

    await t.test('prepared photo component requires consent, permits withdrawal and makes no upload', async t => {
      const dev = await createServer({
        root: fileURLToPath(new URL('../client', import.meta.url)),
        server: { host: '127.0.0.1', port: 0, strictPort: false },
        plugins: [{
          name: 'photo-component-test-only',
          resolveId(id) { if (id === 'virtual:photo-test') return '\0photo-test'; },
          load(id) {
            if (id === '\0photo-test') return `
              import {createApp,h} from 'vue';
              import Photo from '/src/components/GiftPhotoInput.vue';
              import {i18n} from '/src/i18n/index.ts';
              createApp({render:()=>h(Photo,{onChange:value=>{window.selection={consent:value.consent,hasFile:!!value.file}}})}).use(i18n).mount('#app');
            `;
          },
        }],
      });
      await dev.listen();
      t.after(() => dev.close());
      const context = await browser.newContext({ locale: 'de-DE' });
      t.after(() => context.close());
      const page = await context.newPage();
      const posts = [];
      page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
      // Isolate selection/withdrawal: the component itself never uploads a file.
      await page.route('**/photo-component-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="app"></div><script type="module" src="/@id/__x00__photo-test"></script>' }));
      await page.goto(`http://127.0.0.1:${dev.httpServer.address().port}/photo-component-test`);
      const consent = page.getByRole('checkbox');
      const input = page.locator('input[type=file]');
      await consent.waitFor();
      assert.equal(await consent.isChecked(), false);
      assert.equal(await input.isDisabled(), true);
      await consent.check();
      await input.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: await readFile(new URL('../server/dist/assets/mock-caricature.png', import.meta.url)) });
      await page.getByText('Foto ausgewählt', { exact: true }).waitFor();
      await consent.uncheck();
      assert.equal(await input.inputValue(), '');
      assert.deepEqual(await page.evaluate(() => window.selection), { consent: false, hasFile: false });
      await consent.check();
      await input.setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
      await page.getByText('Wähle ein JPEG-, PNG- oder WebP-Bild.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Ohne Foto fortfahren', exact: true }).click();
      assert.equal(await consent.isChecked(), false);
      assert.deepEqual(posts, []);
    });
  },
);
