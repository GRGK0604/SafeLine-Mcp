import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfiguration } from '../src/client.js';
import { startHttpServer } from '../src/http.js';
import { createServer as createMcpServer } from '../src/index.js';

const secret = 'test-static-bearer-token-with-at-least-32-chars';

function childEnv(settings) {
  const inherited = Object.entries(process.env).filter(([name]) => !/^(SAFELINE|MCP)_/.test(name));
  return { ...Object.fromEntries(inherited), ...settings };
}

async function unusedPort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('MCP server startup timed out: ' + output)), 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes('Streamable HTTP listening')) finish();
    };
    const onExit = code => finish(new Error('MCP server exited with code ' + code + ': ' + output));
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

function mcpClient(url) {
  const client = new Client({ name: 'streamable-http-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => secret },
  });
  return { client, transport };
}

test('CLI defaults to authenticated Streamable HTTP and exposes safe tools', async () => {
  const port = await unusedPort();
  const script = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: childEnv({ SAFELINE_BASE_URL: 'https://127.0.0.1:9443', MCP_AUTH_TOKEN: secret, MCP_PORT: String(port) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let client;
  try {
    await waitForReady(child);
    const mcp = mcpClient('http://127.0.0.1:' + port + '/mcp');
    client = mcp.client;
    await client.connect(mcp.transport);
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), [
      'call_operation', 'connection_status', 'describe_operation', 'list_operations',
    ]);
    const status = await client.callTool({ name: 'connection_status', arguments: {} });
    assert.equal(status.structuredContent.operationCount, 227);
    assert.equal(status.structuredContent.configured, false);
    const search = await client.callTool({ name: 'list_operations', arguments: { method: 'GET', search: 'site', limit: 3 } });
    assert.equal(search.structuredContent.operations.length, 3);
    const blocked = await client.callTool({ name: 'call_operation', arguments: { operation: 'DELETE /open/auth/token' } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.structuredContent.error, /Write operation disabled/);
  } finally {
    if (client) await client.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
  }
});

test('Streamable HTTP call_operation forwards GET to the configured SafeLine origin', async () => {
  const seen = [];
  const api = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-slce-api-token'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { total: 1 }, msg: 'success' }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');

  const config = { ...loadConfiguration({ SAFELINE_BASE_URL: 'http://127.0.0.1:' + api.address().port, SAFELINE_API_TOKEN: 'http-test-token' }), mcpPort: 0, mcpAuthToken: secret };
  const server = await startHttpServer(config, () => createMcpServer(config));
  const mcp = mcpClient('http://127.0.0.1:' + server.address().port + '/mcp');
  try {
    await mcp.client.connect(mcp.transport);
    const response = await mcp.client.callTool({
      name: 'call_operation',
      arguments: { operation: 'GET /open/audit_log', query: { page: 2 } },
    });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.ok, true);
    assert.deepEqual(seen, [{ url: '/api/open/audit_log?page=2', token: 'http-test-token' }]);
  } finally {
    await mcp.client.close();
    await new Promise(resolve => server.close(resolve));
    api.close();
    await once(api, 'close');
  }
});

for (const args of [['--http'], ['--config', 'config.json']]) {
  test('removed CLI flag ' + args[0] + ' is rejected', async () => {
    const script = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const result = await new Promise(resolve => {
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('close', code => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: node src\/index.js \(configure with SAFELINE_\* and MCP_\* environment variables\)/);
  });
}
