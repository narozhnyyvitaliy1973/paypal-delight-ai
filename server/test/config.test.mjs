import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, readSettings, repositoryRoot } from "../dist/config.js";
import { resolve } from "node:path";

test('gift configuration defaults to mock and never accepts an unknown provider', () => {
  assert.equal(readSettings({}).aiProvider, 'mock');
  assert.equal(readSettings({ AI_PROVIDER: 'openai' }).aiProvider, 'openai');
  assert.throws(() => readSettings({ AI_PROVIDER: 'unknown' }), /AI_PROVIDER/);
});

test("configuration defaults to the loopback address and default port", () => {
  assert.deepEqual(readConfig({}), { host: "127.0.0.1", port: 8003 });
});

test("configuration accepts explicit host and port", () => {
  assert.deepEqual(readConfig({ HOST: "0.0.0.0", PORT: "9000" }), {
    host: "0.0.0.0",
    port: 9000,
  });
});

test("configuration rejects invalid ports before starting the server", () => {
  for (const port of ["", "0", "-1", "65536", "8003abc", "1.5", "8e3", "NaN"]) {
    assert.throws(() => readConfig({ PORT: port }), /PORT must be an integer/);
  }
});

test("configuration rejects an empty host", () => {
  assert.throws(() => readConfig({ HOST: " " }), /HOST must not be empty/);
});

test("checkout is Sandbox-only and rejects incomplete credentials", () => {
  assert.throws(
    () => readSettings({ PAYPAL_ENVIRONMENT: "live" }),
    /Only.*sandbox/,
  );
  assert.throws(
    () => readSettings({ PAYPAL_CLIENT_ID: "example" }),
    /both PayPal/,
  );
  assert.throws(
    () => readSettings({ PAYPAL_CLIENT_SECRET: "example" }),
    /both PayPal/,
  );
  assert.equal(readSettings({}).clientId, "");
});

test("production requires HTTPS and an absolute persistent DB outside the release", () => {
  assert.throws(() => readSettings({ NODE_ENV: "production" }), /HTTPS/);
  const env = {
    NODE_ENV: "production",
    APP_ORIGIN: "https://delight.example.com",
  };
  assert.throws(() => readSettings(env), /outside the release/);
  assert.throws(
    () =>
      readSettings({
        ...env,
        DATABASE_PATH: resolve(repositoryRoot, "data/orders.sqlite"),
      }),
    /outside the release/,
  );
  assert.throws(
    () =>
      readSettings({
        ...env,
        DATABASE_PATH: resolve(repositoryRoot, "..looks-outside/orders.sqlite"),
      }),
    /outside the release/,
  );
  const path = resolve(repositoryRoot, "../shared/delight.sqlite");
  assert.equal(
    readSettings({ ...env, DATABASE_PATH: path }).databasePath,
    path,
  );
  assert.throws(
    () => readSettings({ DATABASE_PATH: ":memory:" }),
    /persistent/,
  );
});

test("APP_ORIGIN must be an exact origin, without credentials, path, or query", () => {
  for (const origin of [
    "http://localhost:5173/",
    "http://user:pass@localhost:5173",
    "http://localhost:5173?x=1",
    "ftp://localhost",
  ]) {
    assert.throws(() => readSettings({ APP_ORIGIN: origin }));
  }
});
