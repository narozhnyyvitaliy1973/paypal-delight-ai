import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../dist/app.js';

test('GET /api/health returns the service status', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/health' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(response.json(), {
    status: 'ok',
    service: 'paypal-delight-ai',
  });
});

test('unknown API routes return 404', async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/not-found' });

  assert.equal(response.statusCode, 404);
});
