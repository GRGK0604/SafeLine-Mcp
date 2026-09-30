import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, createClient, loadConfiguration } from '../src/client.js';
import { prepareCall, spec } from '../src/catalog.js';

test('configuration rejects non-loopback HTTP and malformed token headers', () => {
  assert.throws(() => configuration({ baseUrl: 'http://example.com:9443' }), /HTTPS/);
  assert.throws(() => configuration({ tokenHeader: 'Bad Header' }), /Invalid tokenHeader/);
  assert.throws(() => configuration({ baseUrl: 'https://example.com/api' }), /must be an origin/);
  assert.throws(() => configuration({ allowMutations: 'true' }), /must be a boolean/);
  assert.throws(() => configuration({ unknownKey: true }), /Unknown config key/);
  assert.throws(() => configuration({ mcpPort: 0 }), /mcpPort must be an integer/);
  assert.throws(() => configuration({ mcpAuthToken: 123 }), /mcpAuthToken must be a string/);
  assert.throws(() => configuration({ caFile: 'certs/ca.pem' }), /Unknown config key: caFile/);
  assert.throws(() => configuration({ tlsFingerprintSha256: 'AA' }), /Unknown config key: tlsFingerprintSha256/);
});

test('loads JSON config and rejects malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeline-config-'));
  const file = join(dir, 'config.json');
  try {
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://127.0.0.1:9443', token: 'private', allowMutations: true }));
    const config = loadConfiguration(file);
    assert.equal(config.token, 'private');
    assert.equal(config.allowMutations, true);
    writeFileSync(file, '{ bad json');
    assert.throws(() => loadConfiguration(file), /Invalid JSON in config file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client sends the token and request body only to the configured API origin', async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, token: req.headers['x-slce-api-token'], body: Buffer.concat(chunks).toString() });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/open/auth/login') res.end(JSON.stringify({ msg: 'internal-error' }));
    else res.end(JSON.stringify({ data: { total: 1 }, msg: 'success' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const config = configuration({ baseUrl: 'http://127.0.0.1:' + port, token: 'private-test-token' });
    const client = createClient(config, spec);
    const list = await client.request(prepareCall({ operation: 'GET /open/audit_log', query: { page: 1 } }, config));
    assert.equal(list.status, 200);
    assert.equal(list.ok, true);
    assert.deepEqual(list.data.data, { total: 1 });
    assert.equal(seen[0].url, '/api/open/audit_log?page=1');
    assert.equal(seen[0].token, 'private-test-token');

    const login = await client.request(prepareCall({ operation: 'POST /open/auth/login', body: { username: 'u' } }, { allowMutations: true, allowSensitive: true }));
    assert.equal(login.ok, false);
    assert.equal(seen[1].method, 'POST');
    assert.deepEqual(JSON.parse(seen[1].body), { username: 'u' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('client refuses responses exceeding the size limit', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end(Buffer.alloc(1024 * 1024 + 1, 'a'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const config = configuration({ baseUrl: 'http://127.0.0.1:' + server.address().port, token: 'test' });
    await assert.rejects(createClient(config, spec).request(
      prepareCall({ operation: 'GET /open/audit_log' }, config)
    ), /exceeds 1 MiB/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
