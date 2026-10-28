// Operator/deployment helper. No Cloudflare or payment network calls, no secret output.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readSettings } from '../server/dist/config.js';

try {
  const file = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  if (file.CLOUDFLARE_ACCOUNT_PLAN !== 'free') throw new Error('Workers Free must be confirmed before enabling the test server.');
  const settings = readSettings({ ...file, NODE_ENV: 'development', AI_PROVIDER: 'cloudflare', AI_ENABLED: 'true' });
  const ai = settings.ai;
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(ai.apiToken)) throw new Error('Unsupported API token format.');
  if (process.argv[2] === '--check') {
    console.log(JSON.stringify({ ready: true, provider: 'cloudflare', model: ai.model, accountPlan: 'free (owner confirmed)',
      dailyRequests: ai.dailyRequests, sessionDailyRequests: ai.sessionDailyRequests, dailyNeurons: ai.dailyNeurons, concurrency: ai.maxConcurrent,
      credentialsPresent: true, secretTransport: 'SSH stdin', aiCalls: 0, serverChanges: false }));
  } else {
    const id = process.argv[3];
    if (process.argv[2] !== '--stage' || !/^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/.test(id ?? '')) throw new Error('Use --check or --stage RELEASE_ID.');
    const payload = { AI_PROVIDER: 'cloudflare', AI_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: ai.accountId,
      CLOUDFLARE_API_TOKEN: ai.apiToken, CLOUDFLARE_MODEL: ai.model, AI_TIMEOUT_MS: String(ai.timeoutMs),
      AI_MAX_CONCURRENT: String(ai.maxConcurrent), AI_DAILY_REQUEST_LIMIT: String(ai.dailyRequests),
      AI_SESSION_DAILY_REQUEST_LIMIT: String(ai.sessionDailyRequests), AI_DAILY_NEURON_LIMIT: String(ai.dailyNeurons),
      AI_LAB_ENABLED: 'true', AI_LAB_PROXY_TOKEN: randomBytes(32).toString('hex'),
      DATABASE_PATH: '/var/www/paypal-delight-ai/shared/delight-stage5.sqlite' };
    const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'root@91.99.101.189',
      `python3 /var/www/paypal-delight-ai/ops/stage-cloudflare.py ${id}`], { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error('Secure staging failed; no configuration was activated.');
    console.log('Cloudflare configuration staged privately; activation is handled by publish.');
  }
} catch {
  console.error('Cloudflare preparation failed. Check Workers Free confirmation, local configuration and SSH access. No secrets printed.');
  process.exitCode = 1;
}
