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

import { z } from 'zod';
import { APIError, type RareCloudClient } from '../client.js';
import { type ToolDefinition, type ToolCallResult, jsonResult, errorResult } from './types.js';

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

// --- write factory (Parity Phase B) ---------------------------------------
//
// writeTool builds a mutating tool (POST/PUT/PATCH/DELETE) on the same
// APIError -> errorResult contract as the read factories, plus three things
// reads never need:
//   1. runtime input validation via a per-tool `.strict()` zod schema (the
//      advertised JSON Schema is what the agent sees; the zod schema is the
//      belt-and-suspenders guard at call time);
//   2. a confirm gate — for money-spend / irreversible tools, the factory
//      injects a required `confirm` boolean and REFUSES (with no HTTP request)
//      unless the caller passes confirm:true;
//   3. MCP annotations (destructiveHint) so a client can warn the user.
// The confirm flag is owned entirely here so per-tool schemas never repeat it.

type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// The confirm param the factory injects when a tool is gated. Owned here so
// per-tool schemas never repeat it.
const CONFIRM_PROPERTY = {
  type: 'boolean' as const,
  description:
    'Set to true to execute. This operation spends from your account balance and/or is irreversible; ' +
    'only pass true after the user has explicitly approved. Omit or false → the tool refuses and makes no API call.',
};

export interface WriteToolOptions<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  method: WriteMethod;
  /** zod schema for the caller's DOMAIN args (never `confirm` — the factory owns that). */
  input: S;
  /** Advertised JSON Schema (closed). Do NOT list `confirm` — the factory injects it when gated. */
  inputSchema: ToolDefinition['inputSchema'];
  /** Build the request path; run EVERY dynamic segment through encodeSegment. */
  buildPath: (args: z.infer<S>) => string;
  /** Build the JSON body. Omit for no-body writes (DELETE, no-body POST). */
  buildBody?: (args: z.infer<S>) => unknown;
  /** true → require confirm:true before any request (money-spend / destructive). */
  confirm?: boolean;
  /** true → advertise annotations.destructiveHint (irreversible). */
  destructiveHint?: boolean;
  /** Override result formatting (e.g. unwrap a returned credential). Default: jsonResult. */
  formatResult?: (data: unknown) => ToolCallResult;
}

export function writeTool<S extends z.ZodObject<z.ZodRawShape>>(
  opts: WriteToolOptions<S>,
): ToolDefinition {
  // Advertise `confirm` on the JSON Schema only when the gate is on.
  const inputSchema: ToolDefinition['inputSchema'] = opts.confirm
    ? {
        ...opts.inputSchema,
        properties: { ...opts.inputSchema.properties, confirm: CONFIRM_PROPERTY },
        required: [...(opts.inputSchema.required ?? []), 'confirm'],
      }
    : opts.inputSchema;

  return {
    name: opts.name,
    description: opts.description,
    inputSchema,
    ...(opts.destructiveHint ? { annotations: { destructiveHint: true } } : {}),
    async handler(client, args) {
      try {
        // Separate the factory-owned confirm flag from the domain args so the
        // per-tool .strict() zod schema never sees it.
        const { confirm, ...domainArgs } = args as { confirm?: unknown } & Record<string, unknown>;

        // 1. Runtime input validation (in addition to the advertised JSON Schema).
        const parsed = opts.input.safeParse(domainArgs);
        if (!parsed.success) {
          return errorResult(`Invalid input for ${opts.name}: ${formatZodError(parsed.error)}`);
        }

        // 2. Confirm gate — refuse with NO request when required and not granted.
        if (opts.confirm && confirm !== true) {
          return errorResult(
            `${opts.name} was NOT executed: it spends from your account balance and/or is ` +
              `irreversible. Re-call with confirm:true only after the user has explicitly approved.`,
          );
        }

        // 3. Build path/body. encodeSegment throws on a traversal token → caught
        //    below → errorResult, so NO request goes out for a bad segment.
        const path = opts.buildPath(parsed.data);
        const body = opts.buildBody ? opts.buildBody(parsed.data) : undefined;

        // 4. Dispatch.
        const data = await callMethod(client, opts.method, path, body);
        return opts.formatResult ? opts.formatResult(data) : jsonResult(data);
      } catch (e) {
        return errorResult(e instanceof APIError ? e.message : (e as Error).message);
      }
    },
  };
}

function callMethod(client: RareCloudClient, method: WriteMethod, path: string, body: unknown): Promise<unknown> {
  switch (method) {
    case 'POST':
      return client.post(path, body);
    case 'PUT':
      return client.put(path, body);
    case 'PATCH':
      return client.patch(path, body);
    case 'DELETE':
      return client.delete(path);
  }
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
