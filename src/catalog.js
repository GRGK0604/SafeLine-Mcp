import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const specPath = fileURLToPath(new URL('../doc.json', import.meta.url));
export const spec = JSON.parse(readFileSync(specPath, 'utf8'));

if (spec.swagger !== '2.0' || !spec.paths || !spec.definitions) {
  throw new Error('doc.json must be a Swagger 2.0 document with paths and definitions');
}

const verbs = ['get', 'post', 'put', 'patch', 'delete'];
const catalog = new Map();
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
const validators = new Map();

// The source Swagger includes repeated enum entries; Ajv rejects these as a
// schema error even though they have no effect on accepted request values.
function normalizeSchema(node) {
  if (Array.isArray(node)) return node.map(normalizeSchema);
  if (!node || typeof node !== 'object') return node;
  const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, normalizeSchema(value)]));
  if (Array.isArray(copy.enum)) {
    const seen = new Set();
    copy.enum = copy.enum.filter(value => {
      const key = JSON.stringify(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return copy;
}
const definitionsForValidation = normalizeSchema(spec.definitions);

const credentialFields = new Set([
  'token', 'secret', 'password', 'private_key', 'jwt', 'csrf_token',
  'api_key', 'access_key', 'cert_key', 'key', 'code',
]);

function hasCredentialField(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(item => hasCredentialField(item, seen));
  if (node.$ref?.startsWith('#/definitions/')) {
    const name = node.$ref.slice('#/definitions/'.length);
    if (seen.has(name)) return false;
    return hasCredentialField(spec.definitions[name], new Set([...seen, name]));
  }
  if (Object.keys(node.properties || {}).some(name => credentialFields.has(name.toLowerCase()))) return true;
  return Object.values(node).some(value => hasCredentialField(value, seen));
}

for (const [path, item] of Object.entries(spec.paths)) {
  for (const verb of verbs) {
    const operation = item[verb];
    if (!operation) continue;
    const key = verb.toUpperCase() + ' ' + path;
    const params = [...(item.parameters || []), ...(operation.parameters || [])];
    catalog.set(key, {
      key,
      method: verb.toUpperCase(),
      path,
      summary: operation.summary || '',
      description: operation.description || '',
      tags: operation.tags || [],
      parameters: params,
      consumes: operation.consumes || spec.consumes || [],
      produces: operation.produces || spec.produces || [],
      mutating: verb !== 'get',
      sensitive: /(?:^|\/)(?:token|secret|csrf)(?:\/|$)/i.test(path) ||
        hasCredentialField(operation.responses),
    });
  }
}

export const operationCount = catalog.size;

export function listOperations({ search = '', tag = '', method = '', offset = 0, limit = 30 } = {}) {
  const needle = search.toLocaleLowerCase();
  const tagFilter = tag.toLocaleLowerCase();
  const methodFilter = method.toUpperCase();
  const matches = [...catalog.values()].filter(op =>
    (!needle || [op.key, op.summary, ...op.tags].some(s => s.toLocaleLowerCase().includes(needle))) &&
    (!tagFilter || op.tags.some(t => t.toLocaleLowerCase() === tagFilter)) &&
    (!methodFilter || op.method === methodFilter)
  );
  return {
    total: matches.length,
    offset,
    limit,
    operations: matches.slice(offset, offset + limit).map(op => ({
      key: op.key,
      summary: op.summary,
      tags: op.tags,
      mutating: op.mutating,
      sensitive: op.sensitive,
    })),
  };
}

function expandSchema(schema, depth = 0, seen = new Set()) {
  if (Array.isArray(schema)) return schema.map(item => expandSchema(item, depth, seen));
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    const name = schema.$ref.replace('#/definitions/', '');
    if (!schema.$ref.startsWith('#/definitions/') || depth >= 4 || seen.has(name)) return schema;
    const definition = spec.definitions[name];
    if (!definition) return schema;
    return expandSchema(definition, depth + 1, new Set([...seen, name]));
  }
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, expandSchema(value, depth, seen)]));
}

export function describeOperation(key) {
  const op = catalog.get(key);
  if (!op) throw new Error('Unknown operation. Use list_operations to find an exact key.');
  return {
    ...op,
    parameters: op.parameters.map(p => ({ ...p, ...(p.schema ? { resolvedSchema: expandSchema(p.schema) } : {}) })),
  };
}

function validateValue(value, schema, label, cacheKey) {
  let validate = validators.get(cacheKey);
  if (!validate) {
    const inputSchema = cacheKey.endsWith('|body')
      ? { ...schema, definitions: definitionsForValidation }
      : schema;
    validate = ajv.compile(inputSchema);
    validators.set(cacheKey, validate);
  }
  if (!validate(value)) {
    const reason = ajv.errorsText(validate.errors, { separator: '; ' });
    throw new Error(label + ' validation failed: ' + reason);
  }
}

function validateParameter(value, param, label, key) {
  const schema = Object.fromEntries(
    ['type', 'format', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'items']
      .filter(field => Object.hasOwn(param, field)).map(field => [field, param[field]])
  );
  if (Object.keys(schema).length) validateValue(value, schema, label, key);
}

function ensureObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  return value;
}

export function prepareCall({ operation, pathParams, query, body }, options = {}) {
  const op = catalog.get(operation);
  if (!op) throw new Error('Unknown operation. Use list_operations to find an exact key.');
  if (op.mutating && !options.allowMutations) {
    throw new Error('Write operation disabled. Set "allowMutations": true in config.json to opt in.');
  }
  if (op.sensitive && !options.allowSensitive) {
    throw new Error('Credential-related operation disabled. Set "allowSensitive": true in config.json to opt in.');
  }

  const paths = ensureObject(pathParams, 'pathParams');
  const queries = ensureObject(query, 'query');
  const allowedPath = new Set(op.parameters.filter(p => p.in === 'path').map(p => p.name));
  const allowedQuery = new Set(op.parameters.filter(p => p.in === 'query').map(p => p.name));
  for (const name of Object.keys(paths)) if (!allowedPath.has(name)) throw new Error('Unknown path parameter: ' + name);
  for (const name of Object.keys(queries)) if (!allowedQuery.has(name)) throw new Error('Unknown query parameter: ' + name);

  let urlPath = op.path;
  for (const param of op.parameters) {
    if (param.in !== 'path' && param.in !== 'query') continue;
    const source = param.in === 'path' ? paths : queries;
    const value = source[param.name];
    if (value === undefined || value === null) {
      if (param.required) throw new Error('Missing required ' + param.in + ' parameter: ' + param.name);
      continue;
    }
    validateParameter(value, param, param.in + ' parameter ' + param.name, op.key + '|' + param.in + '|' + param.name);
    if (param.in === 'path') {
      if (value === '.' || value === '..') throw new Error('Invalid path segment: ' + param.name);
      // Three documented routes use :id rather than Swagger's usual {id}.
      urlPath = urlPath.split('/').map(segment =>
        segment === '{' + param.name + '}' || segment === ':' + param.name
          ? encodeURIComponent(String(value)) : segment
      ).join('/');
    }
  }
  if (urlPath.split('/').some(segment => /^\{[^}]+\}$/.test(segment) || /^:[^/]+$/.test(segment))) {
    throw new Error('Unresolved path parameter');
  }

  const bodyParam = op.parameters.find(p => p.in === 'body');
  if (bodyParam) {
    if (body === undefined && bodyParam.required) throw new Error('Missing required body');
    if (body !== undefined) validateValue(body, bodyParam.schema, 'body', op.key + '|body');
  } else if (body !== undefined) {
    throw new Error('This operation does not declare a body');
  }

  const search = new URLSearchParams();
  for (const param of op.parameters.filter(p => p.in === 'query')) {
    const value = queries[param.name];
    if (value !== undefined && value !== null) search.set(param.name, String(value));
  }
  return { method: op.method, path: urlPath, queryString: search.toString(), body };
}
