import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createServer, preview } from "vite";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const clientRoot = fileURLToPath(new URL("../client", import.meta.url));
const configFile = fileURLToPath(
  new URL("../client/vite.config.ts", import.meta.url),
);

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  assert.ok(address && typeof address === "object");
  return address.port;
}

function originOf(httpServer) {
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function checkHealth(origin) {
  const response = await fetch(`${origin}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "paypal-delight-ai",
  });
}

async function checkPage(origin) {
  const response = await fetch(origin, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>PayPal Delight AI<\/title>/);
  return html;
}

test("compiled backend and both frontend servers work over HTTP", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "delight-smoke-"));
  const port = await availablePort();
  const backendOrigin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/dist/index.js"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      APP_ORIGIN: "http://127.0.0.1:5173",
      DATABASE_PATH: join(dataDirectory, "orders.sqlite"),
      PAYPAL_ENVIRONMENT: "sandbox",
      PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError;
  let closed = false;
  const exit = new Promise((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-16000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  t.after(async () => {
    if (!closed && child.pid) child.kill();
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5000);
    forceKill.unref();
    try {
      await exit;
    } finally {
      clearTimeout(forceKill);
      const target = resolve(dataDirectory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("delight-smoke-"));
      rmSync(target, { recursive: true, force: true });
    }
  });

  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.ok(!spawnError, `Backend could not start: ${spawnError?.message}`);
    assert.ok(!closed, `Backend exited before becoming ready:\n${output}`);
    try {
      const response = await fetch(`${backendOrigin}/api/health`, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(1000, deadline - Date.now())),
        ),
      });
      await response.arrayBuffer();
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // Connection refusal is expected until Fastify starts listening.
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  assert.ok(ready, `Backend was not ready within 10 seconds:\n${output}`);

  await t.test("production backend entrypoint responds", async () => {
    await checkHealth(backendOrigin);
  });

  // Exercise the real Vite proxy configuration with the temporary backend port.
  const previousHost = process.env.HOST;
  const previousPort = process.env.PORT;
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(port);
  t.after(() => {
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  });

  const serverOptions = () => ({
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
  });

  await t.test("Vite dev serves the page and proxies /api", async () => {
    const dev = await createServer({
      root: clientRoot,
      configFile,
      server: serverOptions(),
    });
    try {
      await dev.listen();
      const origin = originOf(dev.httpServer);
      await checkPage(origin);
      await checkHealth(origin);
    } finally {
      await dev.close();
    }
  });

  await t.test(
    "Vite navigates loopback aliases to APP_ORIGIN without redirecting API requests",
    async () => {
      const frontendPort = await availablePort();
      const canonicalOrigin = `http://localhost:${frontendPort}`;
      const previousOrigin = process.env.APP_ORIGIN;
      process.env.APP_ORIGIN = canonicalOrigin;
      let dev;
      try {
        dev = await createServer({
          root: clientRoot,
          configFile,
          server: { host: '127.0.0.1', port: frontendPort, strictPort: true },
        });
        await dev.listen();
        const alias = originOf(dev.httpServer);
        const path = '/?order=test-order&cancelled=1';
        const redirected = await fetch(`${alias}${path}`, {
          headers: { Accept: 'text/html' }, redirect: 'manual',
        });
        assert.equal(redirected.status, 302);
        assert.equal(redirected.headers.get('location'), `${canonicalOrigin}${path}`);
        const canonical = await fetch(canonicalOrigin, {
          headers: { Accept: 'text/html' }, redirect: 'manual',
        });
        assert.equal(canonical.status, 200);
        await checkHealth(alias);
      } finally {
        await dev?.close();
        if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
        else process.env.APP_ORIGIN = previousOrigin;
      }
    },
  );

  await t.test(
    "Vite preview serves built assets and proxies /api",
    async () => {
      const built = await preview({
        root: clientRoot,
        configFile,
        preview: serverOptions(),
      });
      try {
        const origin = originOf(built.httpServer);
        const html = await checkPage(origin);
        const asset = html.match(
          /<script\b[^>]*\bsrc="(\/assets\/[^"?#]+\.js)"/,
        );
        assert.ok(
          asset,
          "Built HTML must reference a JavaScript asset in /assets/",
        );
        const response = await fetch(new URL(asset[1], origin), {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /javascript/);
        assert.ok((await response.text()).length > 0);
        await checkHealth(origin);
      } finally {
        await new Promise((resolve, reject) => {
          built.httpServer.close((error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
    },
  );
});
