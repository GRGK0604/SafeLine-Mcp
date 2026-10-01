import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfiguration } from '../src/client.js';
import { startHttpServer, validBearer } from '../src/http.js';
import { createServer as createMcpServer } from '../src/index.js';

const secret = 'test-static-bearer-token-with-at-least-32-chars';

test('bearer verifier rejects missing and incorrect credentials', () => {
  assert.equal(validBearer(undefined, secret), false);
  assert.equal(validBearer('Basic ' + secret, secret), false);
  assert.equal(validBearer('Bearer wrong', secret), false);
  assert.equal(validBearer('Bearer ' + secret, secret), true);
});

test('Streamable HTTP fails closed without a strong configured token', async () => {
  await assert.rejects(startHttpServer({ mcpPort: 0 }), /requires a random MCP_AUTH_TOKEN/);
  await assert.rejects(startHttpServer({ mcpPort: 0, mcpAuthToken: 'short' }), /requires a random MCP_AUTH_TOKEN/);
});

test('Streamable HTTP denies unauthenticated requests and serves authenticated clients', async () => {
  const config = { ...loadConfiguration({ SAFELINE_BASE_URL: 'https://127.0.0.1:9443' }), mcpPort: 0, mcpAuthToken: secret };
  const server = await startHttpServer(config, () => createMcpServer(config));
  const url = 'http://127.0.0.1:' + server.address().port + '/mcp';
  let client;
  try {
    const unauthenticated = await fetch(url, { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get('www-authenticate'), /^Bearer /);
    assert.doesNotMatch(await unauthenticated.text(), new RegExp(secret));

    const wrong = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrong.status, 401);

    const crossOrigin = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + secret, Origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);

    client = new Client({ name: 'http-auth-test', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      authProvider: { token: async () => secret },
    });
    await client.connect(transport);
    const list = await client.listTools();
    assert.ok(list.tools.some(tool => tool.name === 'call_operation'));
    const status = await client.callTool({ name: 'connection_status', arguments: {} });
    assert.equal(status.structuredContent.configured, false);
  } finally {
    if (client) await client.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('custom bind address enforces Host, Origin, and Bearer before serving MCP', async () => {
  const config = {
    ...loadConfiguration({
      MCP_HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'mcp.example.test',
      MCP_ALLOWED_ORIGINS: 'client.example.test',
      MCP_AUTH_TOKEN: secret,
    }),
    mcpPort: 0,
  };
  const server = await startHttpServer(config, () => createMcpServer(config));
  assert.equal(server.address().address, '0.0.0.0');
  const url = 'http://127.0.0.1:' + server.address().port + '/mcp';
  const initialize = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host-test', version: '1.0' } },
  });
  const request = headers => new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(initialize);
  });
  try {
    assert.equal((await request({ Host: 'wrong.example.test', Authorization: 'Bearer ' + secret })).status, 403);
    assert.equal((await request({ Host: 'mcp.example.test', Origin: 'https://wrong.example.test', Authorization: 'Bearer ' + secret })).status, 403);
    assert.equal((await request({ Host: 'mcp.example.test', Origin: 'https://client.example.test' })).status, 401);
    const valid = await request({ Host: 'mcp.example.test', Origin: 'https://client.example.test', Authorization: 'Bearer ' + secret });
    assert.equal(valid.status, 200);
    assert.match(valid.body, /protocolVersion/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
