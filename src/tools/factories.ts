// Shared tool factories. Extracted from infra.ts so every read tool builds
// on one implementation with identical APIError -> errorResult handling.
// Later parity tasks layer write factories (create/update/delete) alongside
// these.
//
//   readList — GET a fixed collection path, no inputs.
//   readOne  — GET `${prefix}/${encodeURIComponent(id)}`, one required id arg.
//   readTool — GET an arbitrary path built from the args (filters, sub-paths,
//              encoded query strings); the caller supplies the JSON Schema and
//              a buildPath() that returns the full `/v1/...` path.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';

export function readList(name: string, path: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(client) {
      try {
        return jsonResult(await client.get(path));
      } catch (e) {
        return errorResult(e instanceof APIError ? e.message : (e as Error).message);
      }
    },
  };
}

export function readOne(name: string, prefix: string, description: string, idKey = 'id'): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { [idKey]: { type: 'string', description: 'Resource id from the matching list_* tool.' } },
      required: [idKey],
      additionalProperties: false,
    },
    async handler(client, args) {
      try {
        const id = String(args[idKey] ?? '');
        return jsonResult(await client.get(`${prefix}/${encodeURIComponent(id)}`));
      } catch (e) {
        return errorResult(e instanceof APIError ? e.message : (e as Error).message);
      }
    },
  };
}

export function readTool(opts: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  buildPath: (args: Record<string, unknown>) => string;
}): ToolDefinition {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema as ToolDefinition['inputSchema'],
    async handler(client, args) {
      try {
        return jsonResult(await client.get(opts.buildPath(args)));
      } catch (e) {
        return errorResult(e instanceof APIError ? e.message : (e as Error).message);
      }
    },
  };
}
