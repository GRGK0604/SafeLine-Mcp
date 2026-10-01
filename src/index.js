#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { spec, operationCount, listOperations, describeOperation, prepareCall } from './catalog.js';
import { createClient, defaultConfigFile, loadConfiguration } from './client.js';
import { startHttpServer } from './http.js';

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error) {
  return result({ error: error instanceof Error ? error.message : String(error) }, true);
}

export function createServer(config = loadConfiguration()) {
  const client = createClient(config, spec);
  const server = new McpServer(
    { name: 'safeline-swagger-mcp', version: '0.1.0' },
    { instructions: 'Use list_operations to find an exact operation key, describe_operation to inspect parameters, then call_operation. Non-GET methods and credential-related endpoints require explicit server-side opt-in.' }
  );

  server.registerTool('connection_status', {
    description: 'Show SafeLine MCP configuration status without revealing credentials or making a network request.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => result({
    apiOrigin: config.baseUrl?.origin || null,
    configured: Boolean(config.baseUrl && config.token),
    operationCount,
    allowMutations: config.allowMutations,
    allowSensitive: config.allowSensitive,
    insecureTls: config.insecureTls,
  }));

  server.registerTool('list_operations', {
    description: 'Search/paginate the bundled SafeLine Swagger API catalog. Returns exact operation keys for call_operation.',
    inputSchema: z.object({
      search: z.string().optional(),
      tag: z.string().optional(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    annotations: { readOnlyHint: true },
  }, async args => result(listOperations(args)));

  server.registerTool('describe_operation', {
    description: 'Show exact method, path, path/query parameters, required JSON body schema, and safety flags for a SafeLine operation.',
    inputSchema: z.object({ operation: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ operation }) => {
    try { return result(describeOperation(operation)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool('call_operation', {
    description: 'Call an operation from docs/doc.json using its exact key. API token stays server-side. GET is allowed by default; writes and secret endpoints require server-side opt-in.',
    inputSchema: z.object({
      operation: z.string().min(1),
      pathParams: z.record(z.string(), z.unknown()).optional(),
      query: z.record(z.string(), z.unknown()).optional(),
      body: z.unknown().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async args => {
    try {
      const call = prepareCall(args, config);
      const response = await client.request(call);
      return result(response, !response.ok);
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--config' || !args[1])) {
      throw new Error('Usage: node src/index.js [--config /path/to/config.json]');
    }
    const config = loadConfiguration(args.length ? args[1] : defaultConfigFile);
    await startHttpServer(config, () => createServer(config));
    const host = config.mcpHost.includes(':') ? '[' + config.mcpHost + ']' : config.mcpHost;
    console.error('SafeLine MCP Streamable HTTP listening on http://' + host + ':' + config.mcpPort + '/mcp');
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
