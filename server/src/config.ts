import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve, relative, sep } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export function loadRootEnv(): void {
  const envPath = fileURLToPath(new URL("../../.env", import.meta.url));

  try {
    loadEnvFile(envPath);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = (env.HOST ?? "127.0.0.1").trim();
  const rawPort = env.PORT ?? "8003";
  const port = Number(rawPort);

  if (!host) {
    throw new Error("HOST must not be empty.");
  }

  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return { host, port };
}

export function readSettings(env: NodeJS.ProcessEnv = process.env) {
  const aiProvider = env.AI_PROVIDER ?? 'mock';
  if (!['mock', 'cloudflare', 'openai'].includes(aiProvider)) {
    throw new Error('AI_PROVIDER must be mock, cloudflare or openai (not implemented).');
  }
  const ai = readAiSettings(env);
  const labEnabled = env.AI_LAB_ENABLED === 'true';
  if (env.AI_LAB_ENABLED !== undefined && !['true', 'false'].includes(env.AI_LAB_ENABLED))
    throw new Error('AI_LAB_ENABLED must be true or false.');
  const labProxyToken = env.AI_LAB_PROXY_TOKEN ?? '';
  if (labEnabled && !/^[a-f0-9]{64}$/.test(labProxyToken))
    throw new Error('Enabled AI lab requires a private proxy token.');
  if (env.PAYPAL_ENVIRONMENT && env.PAYPAL_ENVIRONMENT !== "sandbox") {
    throw new Error("Only PAYPAL_ENVIRONMENT=sandbox is supported.");
  }
  const production = env.NODE_ENV === "production";
  const rawOrigin = env.APP_ORIGIN ?? "http://127.0.0.1:5173";
  const additionalOrigins = env.APP_ADDITIONAL_ORIGINS?.split(',').map(value => value.trim()) ?? [];
  const allowedOrigins = [...new Set([rawOrigin, ...additionalOrigins])];
  for (const value of allowedOrigins) {
    const parsed = new URL(value);
    if (parsed.origin !== value || parsed.username || parsed.password ||
        !['http:', 'https:'].includes(parsed.protocol) || (production && parsed.protocol !== 'https:'))
      throw new Error('Configured origins must be exact origins without paths; production requires HTTPS.');
  }
  const origin = new URL(rawOrigin);
  if (
    origin.origin !== rawOrigin ||
    origin.username ||
    origin.password ||
    !["http:", "https:"].includes(origin.protocol) ||
    (production && origin.protocol !== "https:")
  ) {
    throw new Error(
      "APP_ORIGIN must be an origin without a path; production requires HTTPS.",
    );
  }
  const rawPath = env.DATABASE_PATH ?? "data/delight.sqlite";
  if (!rawPath.trim() || rawPath === ":memory:")
    throw new Error("DATABASE_PATH must be a persistent file path.");
  const databasePath = resolve(repositoryRoot, rawPath);
  const fromRoot = relative(repositoryRoot, databasePath);
  const outsideRelease =
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot);
  if (production && (!isAbsolute(rawPath) || !outsideRelease)) {
    throw new Error(
      "Production DATABASE_PATH must be absolute and outside the release directory.",
    );
  }
  const clientId = env.PAYPAL_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim() ?? "";
  if (Boolean(clientId) !== Boolean(clientSecret))
    throw new Error(
      "Set both PayPal Sandbox credentials, or leave both empty.",
    );
  return {
    aiProvider: aiProvider as 'mock' | 'cloudflare' | 'openai',
    ai,
    lab: { enabled: labEnabled, proxyToken: labProxyToken },
    production,
    origin: origin.origin,
    allowedOrigins,
    databasePath,
    clientId,
    clientSecret,
  };
}

export type Settings = ReturnType<typeof readSettings>;

export const CLOUDFLARE_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
export const AI_RENDER_TIMEOUT_MS = 270_000;
export const AI_GENERATION_LEASE_MS = 300_000;
export function readAiSettings(env: NodeJS.ProcessEnv = {}) {
  if (env.AI_ENABLED !== undefined && !['true', 'false'].includes(env.AI_ENABLED))
    throw new Error('AI_ENABLED must be true or false.');
  const integer = (key: string, fallback: number, max: number) => {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max)
      throw new Error(`${key} must be an integer between 1 and ${max}.`);
    return Number(value);
  };
  const model = env.CLOUDFLARE_MODEL ?? CLOUDFLARE_MODEL;
  if (model !== CLOUDFLARE_MODEL) throw new Error('Only the approved Cloudflare FLUX.2 klein 4B model is supported.');
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  if (env.AI_PROVIDER === 'cloudflare' && env.AI_ENABLED === 'true' &&
      (!/^[a-f0-9]{32}$/i.test(accountId) || !apiToken || /\s/.test(apiToken)))
    throw new Error('Enabled Cloudflare requires a valid account ID and API token.');
  return {
    enabled: env.AI_ENABLED === 'true', accountId, apiToken, model,
    timeoutMs: integer('AI_TIMEOUT_MS', 240_000, 240_000),
    maxConcurrent: integer('AI_MAX_CONCURRENT', 2, 4),
    dailyRequests: integer('AI_DAILY_REQUEST_LIMIT', 50, 100),
    sessionDailyRequests: integer('AI_SESSION_DAILY_REQUEST_LIMIT', 50, 100),
    dailyNeurons: integer('AI_DAILY_NEURON_LIMIT', 8000, 9000),
  };
}
export type AiSettings = ReturnType<typeof readAiSettings>;
