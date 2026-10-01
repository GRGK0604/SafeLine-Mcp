import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createClient, loadConfiguration } from '../src/client.js';
import { prepareCall, spec } from '../src/catalog.js';

test('configuration rejects non-loopback HTTP and malformed values', () => {
  assert.throws(() => loadConfiguration({ SAFELINE_BASE_URL: 'http://example.com:9443' }), /HTTPS/);
  assert.throws(() => loadConfiguration({ SAFELINE_TOKEN_HEADER: 'Bad Header' }), /Invalid SAFELINE_TOKEN_HEADER/);
  assert.throws(() => loadConfiguration({ SAFELINE_BASE_URL: 'https://example.com/api' }), /must be an origin/);
  assert.throws(() => loadConfiguration({ SAFELINE_ALLOW_MUTATIONS: 'yes' }), /SAFELINE_ALLOW_MUTATIONS must be true or false/);
  assert.throws(() => loadConfiguration({ SAFELINE_TIMEOUT_MS: '15s' }), /SAFELINE_TIMEOUT_MS must be an integer/);
  assert.throws(() => loadConfiguration({ MCP_PORT: '0' }), /MCP_PORT must be an integer/);
  assert.throws(() => loadConfiguration({ MCP_PORT: '3000.5' }), /MCP_PORT must be an integer/);
});

test('configurable MCP bind address requires an explicit Host allowlist outside loopback', () => {
  const local = loadConfiguration({});
  assert.equal(local.mcpHost, '127.0.0.1');
  assert.equal(local.mcpPort, 3000);
  assert.deepEqual(local.mcpAllowedHosts, []);
  assert.deepEqual(local.mcpAllowedOrigins, []);
  assert.throws(() => loadConfiguration({ MCP_HOST: '0.0.0.0' }), /requires at least one MCP_ALLOWED_HOSTS/);
  assert.throws(() => loadConfiguration({ MCP_HOST: 'https://example.com' }), /MCP_HOST must be/);
  assert.throws(() => loadConfiguration({ MCP_HOST: '0.0.0.0:3000' }), /MCP_HOST must be/);
  assert.throws(() => loadConfiguration({ MCP_ALLOWED_HOSTS: '*' }), /entries must be hostnames/);
  assert.throws(() => loadConfiguration({ MCP_ALLOWED_ORIGINS: 'https://example.com' }), /entries must be hostnames/);
  const publicConfig = loadConfiguration({
    MCP_HOST: '0.0.0.0',
    MCP_ALLOWED_HOSTS: 'mcp.example.com, 203.0.113.5',
    MCP_ALLOWED_ORIGINS: 'client.example.com',
  });
  assert.equal(publicConfig.mcpHost, '0.0.0.0');
  assert.deepEqual(publicConfig.mcpAllowedHosts, ['mcp.example.com', '203.0.113.5']);
  assert.deepEqual(publicConfig.mcpAllowedOrigins, ['client.example.com']);
  assert.equal(loadConfiguration({ MCP_HOST: '::', MCP_ALLOWED_HOSTS: '[2001:db8::1]' }).mcpHost, '::');
});

test('reads settings from environment variables and treats empty values as unset', () => {
  const config = loadConfiguration({
    SAFELINE_BASE_URL: 'https://127.0.0.1:9443',
    SAFELINE_API_TOKEN: 'private',
    SAFELINE_ALLOW_MUTATIONS: 'true',
    SAFELINE_ALLOW_SENSITIVE: '',
    SAFELINE_TIMEOUT_MS: '5000',
    MCP_AUTH_TOKEN: '',
    MCP_PORT: '',
  });
  assert.equal(config.baseUrl.origin, 'https://127.0.0.1:9443');
  assert.equal(config.token, 'private');
  assert.equal(config.allowMutations, true);
  assert.equal(config.allowSensitive, false);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.mcpAuthToken, undefined);
  assert.equal(config.mcpPort, 3000);
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
    const config = loadConfiguration({ SAFELINE_BASE_URL: 'http://127.0.0.1:' + port, SAFELINE_API_TOKEN: 'private-test-token' });
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

test('client parses JSON bodies with leading whitespace even without a JSON content type', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end('\n  {"msg":"success","data":[1]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const config = loadConfiguration({ SAFELINE_BASE_URL: 'http://127.0.0.1:' + server.address().port, SAFELINE_API_TOKEN: 'test' });
    const response = await createClient(config, spec).request(prepareCall({ operation: 'GET /open/audit_log' }, config));
    assert.equal(response.ok, true);
    assert.deepEqual(response.data, { msg: 'success', data: [1] });
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
    const config = loadConfiguration({ SAFELINE_BASE_URL: 'http://127.0.0.1:' + server.address().port, SAFELINE_API_TOKEN: 'test' });
    await assert.rejects(createClient(config, spec).request(
      prepareCall({ operation: 'GET /open/audit_log' }, config)
    ), /exceeds 1 MiB/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
