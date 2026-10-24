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
  if (aiProvider !== 'mock' && aiProvider !== 'openai') {
    throw new Error('AI_PROVIDER must be mock or openai (not implemented yet).');
  }
  if (env.PAYPAL_ENVIRONMENT && env.PAYPAL_ENVIRONMENT !== "sandbox") {
    throw new Error("Only PAYPAL_ENVIRONMENT=sandbox is supported.");
  }
  const production = env.NODE_ENV === "production";
  const rawOrigin = env.APP_ORIGIN ?? "http://127.0.0.1:5173";
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
    aiProvider: aiProvider as 'mock' | 'openai',
    production,
    origin: origin.origin,
    databasePath,
    clientId,
    clientSecret,
  };
}

export type Settings = ReturnType<typeof readSettings>;
