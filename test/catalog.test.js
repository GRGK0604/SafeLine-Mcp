import test from 'node:test';
import assert from 'node:assert/strict';
import { spec, operationCount, listOperations, describeOperation, prepareCall } from '../src/catalog.js';

const readOnly = { allowMutations: false, allowSensitive: false };
const fullAccess = { allowMutations: true, allowSensitive: true };

test('catalog indexes all documented operations and filters by tag', () => {
  assert.equal(operationCount, 227);
  const result = listOperations({ tag: 'web_services', method: 'GET', limit: 5 });
  assert.ok(result.total > 0);
  assert.ok(result.operations.every(item => item.key.startsWith('GET ')));
  assert.ok(result.operations.every(item => item.tags.includes('web_services')));
  assert.equal(describeOperation('GET /open/site').key, 'GET /open/site');
});

test('path and query values are validated and serialized', () => {
  const call = prepareCall({
    operation: 'GET /open/site/{id}', pathParams: { id: 12 },
  }, readOnly);
  assert.equal(call.path, '/open/site/12');

  const colon = prepareCall({
    operation: 'GET /open/record/:id', pathParams: { id: 'a/b' },
  }, readOnly);
  assert.equal(colon.path, '/open/record/a%2Fb');

  const query = prepareCall({
    operation: 'GET /open/audit_log', query: { page: 1, page_size: 20 },
  }, readOnly);
  assert.equal(query.queryString, 'page=1&page_size=20');
  assert.throws(() => prepareCall({ operation: 'GET /open/audit_log', query: { page: 0 } }, readOnly), /validation failed/);
  assert.throws(() => prepareCall({ operation: 'GET /open/audit_log', query: { typo: 1 } }, readOnly), /Unknown query parameter/);
  assert.throws(() => prepareCall({ operation: 'GET /open/site/{id}' }, readOnly), /Missing required path/);
  assert.throws(() => prepareCall({ operation: 'GET /open/record/:id', pathParams: { id: '..' } }, readOnly), /Invalid path segment/);
});

test('writes and credential-related routes require explicit opt-in', () => {
  assert.throws(() => prepareCall({ operation: 'POST /open/auth/login', body: {} }, readOnly), /Write operation disabled.*"allowMutations": true in config\.json/);
  assert.throws(() => prepareCall({ operation: 'GET /open/auth/token' }, readOnly), /Credential-related operation disabled.*"allowSensitive": true in config\.json/);
  assert.throws(() => prepareCall({ operation: 'GET /open/auth/csrf' }, readOnly), /Credential-related operation disabled/);
  assert.throws(() => prepareCall({ operation: 'GET /open/cert/{id}', pathParams: { id: 1 } }, readOnly), /Credential-related operation disabled/);
  assert.throws(() => prepareCall({ operation: 'POST /open/auth/login' }, fullAccess), /Missing required body/);
  assert.throws(() => prepareCall({ operation: 'POST /open/auth/login', body: 5 }, fullAccess), /body validation failed/);
  assert.equal(prepareCall({ operation: 'POST /open/auth/login', body: {} }, fullAccess).method, 'POST');
});

test('all documented request body schemas compile', () => {
  let checked = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (!(op.parameters || []).some(param => param.in === 'body')) continue;
      checked++;
      const pathParams = Object.fromEntries((op.parameters || [])
        .filter(param => param.in === 'path')
        .map(param => [param.name, param.type === 'integer' ? 1 : 'test']));
      try {
        prepareCall({ operation: method.toUpperCase() + ' ' + path, pathParams, body: {} }, fullAccess);
      } catch (error) {
        assert.match(error.message, /^body validation failed/, method.toUpperCase() + ' ' + path);
      }
    }
  }
  assert.equal(checked, 95);
});
