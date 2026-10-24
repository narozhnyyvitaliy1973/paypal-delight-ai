import { randomUUID } from "node:crypto";
import { buildApp } from "../dist/app.js";
import { OrderStore } from "../dist/database.js";
import { readSettings } from "../dist/config.js";
import { PayPalClient, PAYPAL_BASE } from "../dist/paypal.js";
import assert from "node:assert/strict";

export class Sandbox {
  orders = new Map();
  createKeys = new Map();
  calls = [];
  captureKeys = [];
  loseCreate = false;
  loseCapture = false;
  failCapture = false;
  captureIssue;
  captureStatus = "COMPLETED";
  mutate;
  gate;
  beforeCapture;
  alreadyCaptured = false;
  unauthorizedOnce = false;
  fetch = async (url, init) => {
    assert.ok(
      url.startsWith(`${PAYPAL_BASE}/`),
      "all traffic must use Sandbox",
    );
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const path = url.slice(PAYPAL_BASE.length);
    this.calls.push({ path, ...init });
    const response = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/v1/oauth2/token")
      return response({
        access_token: "fake-server-access-token",
        expires_in: 3600,
      });
    if (this.unauthorizedOnce) {
      this.unauthorizedOnce = false;
      return response({}, 401);
    }
    assert.equal(init.headers.Authorization, "Bearer fake-server-access-token");
    if (path === "/v2/checkout/orders" && init.method === "POST") {
      const key = init.headers["PayPal-Request-Id"];
      assert.match(key, /^[a-f0-9-]{36}$/);
      let id = this.createKeys.get(key);
      if (!id) {
        const payload = JSON.parse(init.body);
        id = `ORDER${String(this.orders.size + 1).padStart(12, "0")}`;
        this.orders.set(id, {
          id,
          status: "CREATED",
          intent: payload.intent,
          purchase_units: payload.purchase_units.map((unit) => ({
            ...unit,
            payee: { merchant_id: "MERCHANT001" },
          })),
        });
        this.createKeys.set(key, id);
      }
      if (this.loseCreate) {
        this.loseCreate = false;
        throw new Error("lost create response");
      }
      return response(this.orders.get(id), 201);
    }
    const match = path.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    assert.ok(match, `Unexpected provider path ${path}`);
    const remote = this.orders.get(match[1]);
    assert.ok(remote);
    if (match[2]) {
      this.captureKeys.push(init.headers["PayPal-Request-Id"]);
      this.beforeCapture?.();
      if (this.gate) await this.gate;
      if (this.captureIssue)
        return response({ details: [{ issue: this.captureIssue }] }, 422);
      if (this.failCapture) {
        this.failCapture = false;
        throw new Error("network failed before capture");
      }
      this.setCaptured(remote.id);
      if (this.alreadyCaptured)
        return response(
          { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
          422,
        );
      if (this.loseCapture) {
        this.loseCapture = false;
        throw new Error("lost capture response");
      }
      // Real capture responses may omit amount/items/payee at purchase-unit level.
      return response(
        {
          id: remote.id,
          status: "COMPLETED",
          purchase_units: [{ payments: remote.purchase_units[0].payments }],
        },
        201,
      );
    }
    const result = structuredClone(remote);
    this.mutate?.(result);
    return response(result);
  };
  approve(id) {
    this.orders.get(id).status = "APPROVED";
  }
  setCaptured(id) {
    const remote = this.orders.get(id);
    remote.status = "COMPLETED";
    remote.purchase_units[0].payments = {
      captures: [
        {
          id: id.replace("ORDER", "CAPTR"),
          status: this.captureStatus,
          final_capture: true,
          amount: {
            currency_code: "EUR",
            value: remote.purchase_units[0].amount.value,
          },
        },
      ],
    };
  }
}
export async function fixture(t, options = {}) {
  const sandbox = options.sandbox ?? new Sandbox();
  const settings = {
    ...readSettings({
      PAYPAL_CLIENT_ID: "sandbox-test-client",
      PAYPAL_CLIENT_SECRET: "sandbox-test-secret",
    }),
    ...options.settings,
  };
  const store = new OrderStore(options.path ?? ":memory:");
  const gateway = new PayPalClient(
    settings.clientId,
    settings.clientSecret,
    settings.origin,
    sandbox.fetch,
  );
  const app = buildApp(
    {},
    { settings, store, paypal: gateway, rateLimit: options.rateLimit ?? false },
  );
  t.after(() => app.close());
  const bootstrap = await app.inject("/api/store");
  const cookie =
    options.cookie ?? bootstrap.headers["set-cookie"].split(";")[0];
  const send = (path, body = {}, overrides = {}) =>
    app.inject({
      method: "POST",
      url: `/api${path}`,
      headers: {
        cookie,
        origin: settings.origin,
        "Content-Type": "application/json",
      },
      payload: body,
      ...overrides,
    });
  const get = (path, overrides = {}) =>
    app.inject({ url: `/api${path}`, headers: { cookie }, ...overrides });
  const create = async (
    productId = "daybreak-mug",
    requestId = randomUUID(),
  ) => {
    const result = await send("/orders", { productId, requestId });
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  return {
    app,
    store,
    sandbox,
    settings,
    cookie,
    bootstrap,
    send,
    get,
    create,
  };
}
