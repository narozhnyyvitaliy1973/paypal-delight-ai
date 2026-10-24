import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
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
  { timeout: 120_000 },
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

    async function pageFixture(t, scenario = "approve") {
      const f = await fixture(t);
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
      await page.goto(origin);
      await page.getByRole("button", { name: "PayPal", exact: true }).waitFor();
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
  },
);
