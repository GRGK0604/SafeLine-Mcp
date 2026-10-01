import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const maxResponseBytes = 1024 * 1024;
const maxRequestBytes = 1024 * 1024;
export const defaultConfigFile = fileURLToPath(new URL('../config.json', import.meta.url));

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
}

function allowedHostname(value, key) {
  const dnsName = typeof value === 'string' && value.length <= 253 &&
    value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      !(isIP(value) === 4 || /^\[[0-9a-fA-F:.]+\]$/.test(value) && isIP(value.slice(1, -1)) === 6 || dnsName)) {
    throw new Error(key + ' entries must be hostnames or IP addresses without ports or schemes');
  }
  return value;
}

function hostnameList(settings, key) {
  const list = settings[key] ?? [];
  if (!Array.isArray(list)) throw new Error(key + ' must be an array');
  return list.map(value => allowedHostname(value, key));
}

export function configuration(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Config must be a JSON object');
  }
  const allowed = new Set([
    'baseUrl', 'token', 'tokenHeader', 'allowMutations',
    'allowSensitive', 'insecureTls', 'timeoutMs',
    'mcpAuthToken', 'mcpPort', 'mcpHost', 'mcpAllowedHosts', 'mcpAllowedOrigins',
  ]);
  for (const key of Object.keys(settings)) {
    if (!allowed.has(key)) throw new Error('Unknown config key: ' + key);
  }
  for (const key of ['allowMutations', 'allowSensitive', 'insecureTls']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') {
      throw new Error(key + ' must be a boolean');
    }
  }
  for (const key of ['baseUrl', 'token', 'tokenHeader', 'mcpAuthToken', 'mcpHost']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'string') {
      throw new Error(key + ' must be a string');
    }
  }

  const raw = settings.baseUrl;
  let baseUrl;
  if (raw) {
    baseUrl = new URL(raw);
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
      throw new Error('baseUrl must be an origin, such as https://127.0.0.1:9443');
    }
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback(baseUrl.hostname))) {
      throw new Error('baseUrl must use HTTPS (HTTP is allowed only for loopback testing)');
    }
  }

  const tokenHeader = settings.tokenHeader ?? 'X-SLCE-API-TOKEN';
  try { http.validateHeaderName(tokenHeader); }
  catch { throw new Error('Invalid tokenHeader'); }
  const timeoutMs = settings.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new Error('timeoutMs must be an integer between 100 and 120000');
  }
  const mcpPort = settings.mcpPort ?? 3000;
  if (!Number.isSafeInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535) {
    throw new Error('mcpPort must be an integer between 1 and 65535');
  }
  const mcpHost = settings.mcpHost ?? '127.0.0.1';
  if (mcpHost !== 'localhost' && !isIP(mcpHost)) {
    throw new Error('mcpHost must be localhost or an IPv4/IPv6 address without a port');
  }
  const mcpAllowedHosts = hostnameList(settings, 'mcpAllowedHosts');
  const mcpAllowedOrigins = hostnameList(settings, 'mcpAllowedOrigins');
  if (!isLoopback(mcpHost) && mcpAllowedHosts.length === 0) {
    throw new Error('Non-loopback mcpHost requires at least one mcpAllowedHosts entry');
  }
  return {
    baseUrl,
    token: settings.token,
    tokenHeader,
    allowMutations: settings.allowMutations ?? false,
    allowSensitive: settings.allowSensitive ?? false,
    insecureTls: settings.insecureTls ?? false,
    timeoutMs,
    mcpAuthToken: settings.mcpAuthToken,
    mcpPort,
    mcpHost,
    mcpAllowedHosts,
    mcpAllowedOrigins,
  };
}

export function loadConfiguration(configFile = defaultConfigFile) {
  const file = resolve(configFile);
  let contents;
  try { contents = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Missing config file: ' + file + '. Copy config.example.json to config.json.');
    }
    throw new Error('Cannot read config file: ' + file + ' (' + error.code + ')');
  }
  let settings;
  try { settings = JSON.parse(contents); }
  catch { throw new Error('Invalid JSON in config file: ' + file); }
  return configuration(settings);
}

export function createClient(config, spec) {
  const basePath = spec.basePath || '';

  async function request(call) {
    if (!config.baseUrl) throw new Error('Set baseUrl in config.json before calling the SafeLine API');
    if (!config.token) throw new Error('Set token in config.json before calling the SafeLine API');
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
          const contentType = String(res.headers['content-type'] || '');
          let data;
          if (contentType.includes('application/json') || /^[\s]*[\[{]/.test(buffer.toString('utf8', 0, 1))) {
            try { data = JSON.parse(buffer.toString('utf8')); }
            catch { data = buffer.toString('utf8'); }
          } else if (contentType.includes('application/octet-stream')) {
            data = { base64: buffer.toString('base64'), contentType, size: buffer.length };
          } else {
            data = buffer.toString('utf8');
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
