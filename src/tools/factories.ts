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

// Encode a value as a single URL path segment, rejecting path-traversal tokens.
// Segments come straight from tool args; a raw "." / ".." (or an empty value)
// would let a caller walk the API path — e.g. `service_id: ".."` turning
// `/v1/services/{id}/scale` into `/v1/services/../scale`. We reject those
// before the path is built. Any value merely CONTAINING dots ("v1.2.3",
// "..foo") is fine — only the exact traversal tokens are blocked.
//
// Throws a plain Error whose message the read-tool handlers' try/catch maps to
// an errorResult. Because it throws inside buildPath (or before client.get in
// readOne), NO request is ever issued for a bad segment.
export function encodeSegment(value: unknown, paramName: string): string {
  const s = String(value ?? '');
  if (s === '' || s === '.' || s === '..') {
    throw new Error(`Invalid ${paramName} value`);
  }
  return encodeURIComponent(s);
}

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
        const seg = encodeSegment(args[idKey], idKey);
        return jsonResult(await client.get(`${prefix}/${seg}`));
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
