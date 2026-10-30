import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fixture } from "./helpers.mjs";

function removeTestDirectory(dir) {
  const target = resolve(dir);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.match(basename(target), /^delight-(test|lock)-/);
  rmSync(target, { recursive: true, force: true });
}

test("catalog has three server-priced EUR products; only public credentials are exposed", async (t) => {
  const f = await fixture(t);
  const data = f.bootstrap.json();
  assert.equal(data.products.length, 3);
  assert.ok(
    data.products.every(
      (p) => p.currency === "EUR" && Number.isInteger(p.amountMinor),
    ),
  );
  assert.equal(data.checkout.clientId, "sandbox-test-client");
  assert.ok(!f.bootstrap.body.includes("sandbox-test-secret"));
  assert.match(f.bootstrap.headers["set-cookie"], /HttpOnly/);
  assert.match(f.bootstrap.headers["set-cookie"], /SameSite=Lax/);
  assert.equal(f.bootstrap.headers["cache-control"], "no-store");
});

test("create uses server product snapshot and rejects injected price/status/unknown products", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { amountMinor: 1 },
    { status: "COMPLETED" },
    { currency: "USD" },
    { name: "Free" },
  ]) {
    assert.equal(
      (
        await f.send("/orders", {
          productId: "starry-night-puzzle",
          requestId: randomUUID(),
          ...extra,
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(
    (await f.send("/orders", { productId: "unknown", requestId: randomUUID() }))
      .statusCode,
    400,
  );
  assert.equal(f.sandbox.orders.size, 0);
  const order = await f.create();
  assert.equal(order.amountMinor, 2990);
  assert.equal(order.currency, "EUR");
  const payload = JSON.parse(
    f.sandbox.calls.find((call) => call.path === "/v2/checkout/orders").body,
  );
  assert.equal(payload.purchase_units[0].amount.value, "29.90");
  assert.equal(payload.purchase_units[0].items[0].sku, "starry-night-puzzle");
  assert.equal(payload.purchase_units[0].custom_id, order.id);
  assert.equal(
    payload.payment_source.paypal.experience_context.shipping_preference,
    "NO_SHIPPING",
  );
  assert.equal((await f.get(`/orders/${order.id}/gift`)).statusCode, 409);
});

test("approved capture persists verified IDs and one gift; all repeat processing is idempotent", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const order = await f.create("starry-night-puzzle", key);
  assert.equal((await f.create("starry-night-puzzle", key)).id, order.id);
  assert.equal(
    (await f.send("/orders", { productId: "great-wave-puzzle", requestId: key }))
      .statusCode,
    409,
  );
  assert.equal(f.sandbox.orders.size, 1);
  f.sandbox.approve(order.paypalOrderId);
  const paid = (await f.send(`/orders/${order.id}/capture`)).json();
  assert.equal(paid.status, "COMPLETED");
  assert.ok(paid.captureId);
  assert.equal(paid.gift.status, "AVAILABLE");
  const id = paid.gift.id;
  for (const operation of ["capture", "capture", "reconcile", "cancel"]) {
    const repeat = (await f.send(`/orders/${order.id}/${operation}`)).json();
    assert.equal(repeat.gift.id, id);
    assert.equal(repeat.status, "COMPLETED");
  }
  assert.equal(f.sandbox.captureKeys.length, 1);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM gift_entitlements").get().n,
    1,
  );
  f.store.db
    .prepare(
      "UPDATE gift_entitlements SET status = 'GENERATED' WHERE order_id = ?",
    )
    .run(order.id);
  f.store.complete(order.id, paid.captureId);
  assert.equal(
    (await f.get(`/orders/${order.id}/gift`)).json().gift.status,
    "COMPLETED",
  );
});

test("unapproved and cancelled purchases never capture or receive a gift", async (t) => {
  const f = await fixture(t);
  const order = await f.create();
  const early = await f.send(`/orders/${order.id}/capture`);
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, "APPROVAL_REQUIRED");
  assert.equal(
    (await f.send(`/orders/${order.id}/cancel`)).json().status,
    "CANCELLED",
  );
  f.sandbox.approve(order.paypalOrderId);
  assert.equal(
    (await f.send(`/orders/${order.id}/capture`)).json().status,
    "CANCELLED",
  );
  assert.equal(f.sandbox.captureKeys.length, 0);
  assert.equal((await f.get(`/orders/${order.id}/gift`)).statusCode, 409);
});

test("declined instrument is persisted and does not unlock success", async (t) => {
  const f = await fixture(t);
  const order = await f.create();
  f.sandbox.approve(order.paypalOrderId);
  f.sandbox.captureIssue = "INSTRUMENT_DECLINED";
  const result = await f.send(`/orders/${order.id}/capture`);
  assert.equal(result.json().status, "DECLINED");
  assert.equal(result.json().gift, null);
  await f.send(`/orders/${order.id}/capture`);
  assert.equal(f.sandbox.captureKeys.length, 1);
  assert.equal((await f.get(`/orders/${order.id}/gift`)).statusCode, 409);
});

test("pending capture unlocks only after later server confirmation", async (t) => {
  const f = await fixture(t);
  const order = await f.create();
  f.sandbox.approve(order.paypalOrderId);
  f.sandbox.captureStatus = "PENDING";
  assert.equal(
    (await f.send(`/orders/${order.id}/capture`)).json().status,
    "PENDING",
  );
  assert.ok(
    f.store.get(order.id).capture_id,
    "pending capture identifier is retained",
  );
  assert.equal((await f.get(`/orders/${order.id}/gift`)).statusCode, 409);
  await f.send(`/orders/${order.id}/capture`);
  assert.equal(f.sandbox.captureKeys.length, 1);
  f.sandbox.captureStatus = "COMPLETED";
  f.sandbox.setCaptured(order.paypalOrderId);
  assert.equal(
    (await f.send(`/orders/${order.id}/reconcile`)).json().status,
    "COMPLETED",
  );
});

test("lost create response retries same PayPal request ID and same local order", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  f.sandbox.loseCreate = true;
  assert.equal(
    (await f.send("/orders", { productId: "starry-night-puzzle", requestId: key }))
      .statusCode,
    502,
  );
  const created = await f.create("starry-night-puzzle", key);
  assert.equal(f.sandbox.orders.size, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM orders").get().n, 1);
  assert.equal(created.paypalOrderId, [...f.sandbox.orders.keys()][0]);
  assert.equal(
    f.sandbox.calls.filter((call) => call.path === "/v2/checkout/orders")
      .length,
    2,
  );
});

test("ambiguous create is never replayed after the bounded retry window", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  f.sandbox.loseCreate = true;
  await f.send("/orders", { productId: "starry-night-puzzle", requestId: key });
  f.store.db.prepare("UPDATE orders SET created_at = 0").run();
  const result = await f.send("/orders", {
    productId: "starry-night-puzzle",
    requestId: key,
  });
  assert.equal(result.json().code, "ORDER_EXPIRED");
  assert.equal(
    f.sandbox.calls.filter((call) => call.path === "/v2/checkout/orders")
      .length,
    1,
  );
});

test("capture timeout before processing retries with persistent capture request ID", async (t) => {
  const f = await fixture(t);
  const order = await f.create();
  f.sandbox.approve(order.paypalOrderId);
  f.sandbox.failCapture = true;
  assert.equal((await f.send(`/orders/${order.id}/capture`)).statusCode, 502);
  assert.equal(
    (await f.get(`/orders/${order.id}`)).json().captureAttempted,
    true,
  );
  assert.equal((await f.get(`/orders/${order.id}/gift`)).statusCode, 409);
  assert.equal(
    (await f.send(`/orders/${order.id}/capture`)).json().status,
    "COMPLETED",
  );
  assert.equal(f.sandbox.captureKeys.length, 2);
  assert.equal(new Set(f.sandbox.captureKeys).size, 1);
});

test("lost capture response survives restart and reconciliation issues exactly one gift", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "delight-test-"));
  // Test-owned temporary directory, not an application data directory.
  let first, second, third;
  t.after(async () => {
    await first?.app.close();
    await second?.app.close();
    await third?.app.close();
    removeTestDirectory(dir);
  });
  const path = join(dir, "orders.sqlite");
  first = await fixture(t, { path });
  const order = await first.create();
  first.sandbox.approve(order.paypalOrderId);
  first.sandbox.loseCapture = true;
  assert.equal(
    (await first.send(`/orders/${order.id}/capture`)).statusCode,
    502,
  );
  await first.app.close();
  second = await fixture(t, {
    path,
    sandbox: first.sandbox,
    cookie: first.cookie,
  });
  assert.equal(
    (await second.get(`/orders/${order.id}`)).json().captureAttempted,
    true,
  );
  const recovered = await second.send(`/orders/${order.id}/reconcile`);
  assert.equal(recovered.json().status, "COMPLETED");
  assert.equal(first.sandbox.captureKeys.length, 1);
  assert.equal(
    (await second.send(`/orders/${order.id}/cancel`)).json().gift.id,
    recovered.json().gift.id,
  );
  await second.app.close();
  third = await fixture(t, {
    path,
    sandbox: first.sandbox,
    cookie: first.cookie,
  });
  assert.equal(
    (await third.get(`/orders/${order.id}/gift`)).json().gift.id,
    recovered.json().gift.id,
  );
  await third.app.close();
});

test("concurrent captures across two application instances share the SQLite operation lock", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "delight-lock-"));
  let a, b;
  t.after(async () => {
    await a?.app.close();
    await b?.app.close();
    removeTestDirectory(dir);
  });
  const path = join(dir, "orders.sqlite");
  a = await fixture(t, { path });
  b = await fixture(t, { path, sandbox: a.sandbox, cookie: a.cookie });
  const order = await a.create();
  a.sandbox.approve(order.paypalOrderId);
  let release;
  a.sandbox.gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  a.sandbox.beforeCapture = entered;
  const first = a.send(`/orders/${order.id}/capture`);
  try {
    await started;
    const second = await b.send(`/orders/${order.id}/capture`);
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "ORDER_BUSY");
  } finally {
    release();
  }
  assert.equal((await first).json().status, "COMPLETED");
  assert.equal(a.sandbox.captureKeys.length, 1);
  await a.app.close();
  await b.app.close();
});

test("ORDER_ALREADY_CAPTURED is recovered only through a verified GET", async (t) => {
  const f = await fixture(t);
  const order = await f.create();
  f.sandbox.approve(order.paypalOrderId);
  f.sandbox.alreadyCaptured = true;
  assert.equal(
    (await f.send(`/orders/${order.id}/capture`)).json().status,
    "COMPLETED",
  );
  assert.equal(f.sandbox.captureKeys.length, 1);
});

test("foreign sessions, missing cookies, forged status and cross-origin requests are rejected", async (t) => {
  const f = await fixture(t);
  const order = await f.create();
  const other = `delight_session=${"b".repeat(64)}`;
  for (const operation of ["capture", "reconcile", "cancel"]) {
    assert.equal(
      (
        await f.send(
          `/orders/${order.id}/${operation}`,
          {},
          {
            headers: {
              cookie: other,
              origin: f.settings.origin,
              "Content-Type": "application/json",
            },
          },
        )
      ).statusCode,
      404,
    );
  }
  assert.equal(
    (await f.get(`/orders/${order.id}/gift`, { headers: { cookie: other } }))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.get(`/orders/${order.id}`, { headers: {} })).statusCode,
    401,
  );
  assert.equal(
    (await f.send(`/orders/${order.id}/capture`, { status: "COMPLETED" }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.send(
        `/orders/${order.id}/capture`,
        {},
        {
          headers: {
            cookie: f.cookie,
            origin: "https://evil.example",
            "Content-Type": "application/json",
          },
        },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.send(
        `/orders/${order.id}/capture`,
        {},
        { headers: { cookie: f.cookie, "Content-Type": "application/json" } },
      )
    ).statusCode,
    403,
  );
  assert.equal(f.sandbox.captureKeys.length, 0);
});

const mutations = {
  amount: (r) => {
    r.purchase_units[0].amount.value = "0.01";
  },
  currency: (r) => {
    r.purchase_units[0].amount.currency_code = "USD";
  },
  merchant: (r) => {
    r.purchase_units[0].payee.merchant_id = "OTHER";
  },
  reference: (r) => {
    r.purchase_units[0].custom_id = randomUUID();
  },
  orderId: (r) => {
    r.id = "OTHERORDER12345";
  },
  product: (r) => {
    r.purchase_units[0].items[0].sku = "another-product";
  },
  captureAmount: (r) => {
    r.purchase_units[0].payments.captures[0].amount.value = "0.01";
  },
  captureCurrency: (r) => {
    r.purchase_units[0].payments.captures[0].amount.currency_code = "USD";
  },
  partialCapture: (r) => {
    r.purchase_units[0].payments.captures[0].final_capture = false;
  },
  multipleCaptures: (r) => {
    r.purchase_units[0].payments.captures.push(
      r.purchase_units[0].payments.captures[0],
    );
  },
  incompleteOrder: (r) => {
    r.status = "APPROVED";
  },
  missingCapture: (r) => {
    delete r.purchase_units[0].payments;
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`payment verification rejects ${name} and preserves the gift gate`, async (t) => {
    const f = await fixture(t);
    const order = await f.create();
    f.sandbox.setCaptured(order.paypalOrderId);
    f.sandbox.mutate = mutate;
    const result = await f.send(`/orders/${order.id}/reconcile`);
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().code, "PAYMENT_MISMATCH");
    assert.equal(f.store.get(order.id).status, "REVIEW");
    assert.equal((await f.get(`/orders/${order.id}/gift`)).statusCode, 409);
  });
}

test("gift and completed state roll back together on a duplicate capture ID", async (t) => {
  const f = await fixture(t);
  const one = await f.create();
  const two = await f.create("great-wave-puzzle");
  f.store.complete(one.id, "CAPTURE0000001");
  assert.throws(() => f.store.complete(two.id, "CAPTURE0000001"), /UNIQUE/);
  assert.equal(f.store.get(two.id).status, "CREATED");
  assert.equal(f.store.gift(two.id), undefined);
  assert.throws(
    () =>
      f.store.db
        .prepare(
          "INSERT INTO gift_entitlements(id,order_id,created_at) VALUES(?,?,?)",
        )
        .run(randomUUID(), two.id, Date.now()),
    /Payment required/,
  );
});

test("OAuth access token stays server-side, is cached, and refreshes on one 401", async (t) => {
  const f = await fixture(t);
  f.sandbox.unauthorizedOnce = true;
  const first = await f.create();
  await f.create("great-wave-puzzle");
  assert.equal(
    f.sandbox.calls.filter((c) => c.path === "/v1/oauth2/token").length,
    2,
  );
  assert.ok(!JSON.stringify(first).includes("fake-server-access-token"));
  assert.notEqual(
    f.store.get(first.id).create_request_id,
    f.store.get(first.id).capture_request_id,
  );
});

test("unconfigured checkout is explicit and does not call PayPal", async (t) => {
  const f = await fixture(t, { settings: { clientId: "", clientSecret: "" } });
  assert.equal(f.bootstrap.json().checkout.enabled, false);
  assert.equal(
    (
      await f.send("/orders", {
        productId: "starry-night-puzzle",
        requestId: randomUUID(),
      })
    ).statusCode,
    503,
  );
  assert.equal(f.sandbox.calls.length, 0);
});

test("payment endpoints enforce a per-IP request limit", async (t) => {
  const f = await fixture(t, { rateLimit: true });
  const order = await f.create();
  let result;
  for (let i = 0; i < 31; i++)
    result = await f.send(`/orders/${order.id}/cancel`);
  assert.equal(result.statusCode, 429);
  assert.equal(result.json().code, "RATE_LIMITED");
});
