import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export function loadRootEnv(): void {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));

  try {
    loadEnvFile(envPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = (env.HOST ?? '127.0.0.1').trim();
  const rawPort = env.PORT ?? '8003';
  const port = Number(rawPort);

  if (!host) {
    throw new Error('HOST must not be empty.');
  }

  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return { host, port };
}
