import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { configuration } from '../src/client.js';
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
  await assert.rejects(startHttpServer({ mcpPort: 0 }), /requires a random mcpAuthToken/);
  await assert.rejects(startHttpServer({ mcpPort: 0, mcpAuthToken: 'short' }), /requires a random mcpAuthToken/);
});

test('Streamable HTTP denies unauthenticated requests and serves authenticated clients', async () => {
  const config = { ...configuration({ baseUrl: 'https://127.0.0.1:9443', token: '' }), mcpPort: 0, mcpAuthToken: secret };
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
