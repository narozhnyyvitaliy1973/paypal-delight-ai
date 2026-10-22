import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../dist/config.js';

test('configuration defaults to the loopback address and default port', () => {
  assert.deepEqual(readConfig({}), { host: '127.0.0.1', port: 8003 });
});

test('configuration accepts explicit host and port', () => {
  assert.deepEqual(readConfig({ HOST: '0.0.0.0', PORT: '9000' }), {
    host: '0.0.0.0',
    port: 9000,
  });
});

test('configuration rejects invalid ports before starting the server', () => {
  for (const port of ['', '0', '-1', '65536', '8003abc', '1.5', '8e3', 'NaN']) {
    assert.throws(() => readConfig({ PORT: port }), /PORT must be an integer/);
  }
});

test('configuration rejects an empty host', () => {
  assert.throws(() => readConfig({ HOST: ' ' }), /HOST must not be empty/);
});
