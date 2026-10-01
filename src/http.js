import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';

export function validBearer(header, secret) {
  if (typeof header !== 'string' || typeof secret !== 'string') return false;
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (!token || Array.from(token).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return false;
  const actual = Buffer.from(token, 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startHttpServer(config, serverFactory) {
  if (typeof config.mcpAuthToken !== 'string' || config.mcpAuthToken.length < 32 ||
      Array.from(config.mcpAuthToken).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw new Error('Streamable HTTP requires a random MCP_AUTH_TOKEN of at least 32 non-whitespace characters');
  }
  const { mcpHost, mcpAllowedHosts: allowedHosts, mcpAllowedOrigins: allowedOrigins } = config;
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(mcpHost.toLowerCase());
  const handler = createMcpHandler(serverFactory);
  const nodeHandler = toNodeHandler(handler);
  const validateHost = allowedHosts.length ? hostHeaderValidation(allowedHosts) : localhostHostValidation();
  const validateOrigin = allowedOrigins.length ? originValidation(allowedOrigins) :
    loopback ? localhostOriginValidation() : originValidation([]);

  const server = createHttpServer((req, res) => {
    if (req.url?.split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found');
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (!validBearer(req.headers.authorization, config.mcpAuthToken)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer realm="safeline-mcp"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    Promise.resolve().then(() => nodeHandler(req, res)).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });
  server.on('close', () => { void handler.close().catch(() => {}); });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.mcpPort, mcpHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  return server;
}
