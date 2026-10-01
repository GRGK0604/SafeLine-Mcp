import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const maxResponseBytes = 1024 * 1024;
const maxRequestBytes = 1024 * 1024;

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
}

function allowedHostname(value, name) {
  const dnsName = value.length <= 253 &&
    value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
  if (!(isIP(value) === 4 || /^\[[0-9a-fA-F:.]+\]$/.test(value) && isIP(value.slice(1, -1)) === 6 || dnsName)) {
    throw new Error(name + ' entries must be hostnames or IP addresses without ports or schemes');
  }
  return value;
}

function envValue(env, name) {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function envBoolean(env, name) {
  const value = envValue(env, name);
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(name + ' must be true or false');
}

function envInteger(env, name, fallback, min, max) {
  const value = envValue(env, name);
  const number = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return number;
}

function hostnameList(env, name) {
  const value = envValue(env, name);
  if (value === undefined) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean).map(item => allowedHostname(item, name));
}

export function loadConfiguration(env = process.env) {
  const raw = envValue(env, 'SAFELINE_BASE_URL');
  let baseUrl;
  if (raw) {
    baseUrl = new URL(raw);
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
      throw new Error('SAFELINE_BASE_URL must be an origin, such as https://127.0.0.1:9443');
    }
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback(baseUrl.hostname))) {
      throw new Error('SAFELINE_BASE_URL must use HTTPS (HTTP is allowed only for loopback testing)');
    }
  }

  const tokenHeader = envValue(env, 'SAFELINE_TOKEN_HEADER') ?? 'X-SLCE-API-TOKEN';
  try { http.validateHeaderName(tokenHeader); }
  catch { throw new Error('Invalid SAFELINE_TOKEN_HEADER'); }
  const timeoutMs = envInteger(env, 'SAFELINE_TIMEOUT_MS', 15000, 100, 120000);
  const mcpPort = envInteger(env, 'MCP_PORT', 3000, 1, 65535);
  const mcpHost = envValue(env, 'MCP_HOST') ?? '127.0.0.1';
  if (mcpHost !== 'localhost' && !isIP(mcpHost)) {
    throw new Error('MCP_HOST must be localhost or an IPv4/IPv6 address without a port');
  }
  const mcpAllowedHosts = hostnameList(env, 'MCP_ALLOWED_HOSTS');
  const mcpAllowedOrigins = hostnameList(env, 'MCP_ALLOWED_ORIGINS');
  if (!isLoopback(mcpHost) && mcpAllowedHosts.length === 0) {
    throw new Error('Non-loopback MCP_HOST requires at least one MCP_ALLOWED_HOSTS entry');
  }
  return {
    baseUrl,
    token: envValue(env, 'SAFELINE_API_TOKEN'),
    tokenHeader,
    allowMutations: envBoolean(env, 'SAFELINE_ALLOW_MUTATIONS'),
    allowSensitive: envBoolean(env, 'SAFELINE_ALLOW_SENSITIVE'),
    insecureTls: envBoolean(env, 'SAFELINE_INSECURE_TLS'),
    timeoutMs,
    mcpAuthToken: envValue(env, 'MCP_AUTH_TOKEN'),
    mcpPort,
    mcpHost,
    mcpAllowedHosts,
    mcpAllowedOrigins,
  };
}

export function createClient(config, spec) {
  const basePath = spec.basePath || '';

  async function request(call) {
    if (!config.baseUrl) throw new Error('Set SAFELINE_BASE_URL before calling the SafeLine API');
    if (!config.token) throw new Error('Set SAFELINE_API_TOKEN before calling the SafeLine API');
    const base = config.baseUrl;
    const url = new URL(basePath.replace(/\/$/, '') + call.path, base);
    if (url.origin !== base.origin) throw new Error('Request escaped the configured SafeLine origin');
    if (call.queryString) url.search = call.queryString;

    const payload = call.body === undefined ? undefined : Buffer.from(JSON.stringify(call.body));
    if (payload && payload.length > maxRequestBytes) throw new Error('Request body exceeds 1 MiB');
    const headers = {
      Accept: 'application/json, application/octet-stream',
      [config.tokenHeader]: config.token,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const options = {
      method: call.method,
      headers,
      timeout: config.timeoutMs,
      ...(base.protocol === 'https:' ? { rejectUnauthorized: !config.insecureTls } : {}),
    };
    const transport = base.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(url, options, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            req.destroy(new Error('SafeLine response exceeds 1 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          const contentType = String(res.headers['content-type'] || '');
          let data;
          if (contentType.includes('application/json') || /^\s*[\[{]/.test(text)) {
            try { data = JSON.parse(text); }
            catch { data = text; }
          } else if (contentType.includes('application/octet-stream')) {
            data = { base64: buffer.toString('base64'), contentType, size: buffer.length };
          } else {
            data = text;
          }
          const status = res.statusCode || 0;
          const apiError = data && typeof data === 'object' && (
            (typeof data.err === 'string' && data.err.length > 0) ||
            (typeof data.msg === 'string' && !['', 'ok', 'success'].includes(data.msg.toLowerCase()))
          );
          resolve({ status, ok: status >= 200 && status < 300 && !apiError, data });
        });
      });
      req.on('timeout', () => req.destroy(new Error('SafeLine request timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  return { request };
}
