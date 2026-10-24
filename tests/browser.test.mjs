import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview, createServer } from "vite";
import { fixture } from "../server/test/helpers.mjs";

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
          3,
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
        const stranger = await browser.newContext();
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
      assert.equal(await f.page.locator('.gift-options button:disabled').count(), 3);
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
      assert.match(await f.page.locator('.legal-page').textContent(), /No personalised gift result/);
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
      // Test-only harness: the photo form is intentionally absent from the customer flow in 3A.
      await page.route('**/photo-component-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="app"></div><script type="module" src="/@id/__x00__photo-test"></script>' }));
      await page.goto(`http://127.0.0.1:${dev.httpServer.address().port}/photo-component-test`);
      const consent = page.getByRole('checkbox');
      const input = page.locator('input[type=file]');
      await consent.waitFor();
      assert.equal(await consent.isChecked(), false);
      assert.equal(await input.isDisabled(), true);
      await consent.check();
      await input.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('local selection only') });
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
