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
//   defineReadTool: wraps a hand-written read handler (one that needs custom
//              result formatting) so it gets the same annotations and secret
//              marking as the factory-built reads.
//
// Every read tool carries READ_ANNOTATIONS (readOnlyHint etc.) so MCP clients
// can auto-approve reads. A read that returns a live credential passes
// `returnsSecret`, which appends the one standardized SECURITY sentence.

import { z } from 'zod';
import { APIError, type RareCloudClient } from '../client.js';
import { isIdempotentPostPath, isValidIdempotencyKey, type ReplayInfo } from '../idempotency.js';
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

// Annotations shared by every read tool: it only inspects state, so a client
// may auto-approve it. openWorldHint: it talks to the live RareCloud API.
export const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

/**
 * The one standardized sentence for a tool whose RESULT contains a live
 * credential. `what` names it, e.g. "a kubeconfig embedding a bearer token".
 */
export function secretSentence(what: string): string {
  return (
    `SECURITY: the result contains ${what}, a live credential. Treat it as a secret: do not repeat it ` +
    'to the user, or write it to files or logs, unless the user explicitly asks; pass it straight to ' +
    'whatever needs it.'
  );
}

/**
 * The one standardized sentence for a tool whose INPUT is a secret. `what`
 * names it, e.g. "the password".
 */
export function inputSecretSentence(what: string): string {
  return (
    `SECURITY: treat ${what} you pass in as a secret (a live credential): never echo the value back to ` +
    'the user, or write it to files or logs.'
  );
}

export interface ReadOptions {
  /** The result contains a live credential; names it for the SECURITY sentence. */
  returnsSecret?: string;
  /** readOne only: the list_* tool the id comes from, named in the id parameter description. */
  idSource?: string;
}

function withSecret(description: string, returnsSecret?: string): string {
  return returnsSecret ? `${description} ${secretSentence(returnsSecret)}` : description;
}

/** Hand-written read tool: adds READ_ANNOTATIONS and the optional SECURITY sentence. */
export function defineReadTool(
  def: Omit<ToolDefinition, 'annotations'>,
  opts: ReadOptions = {},
): ToolDefinition {
  return {
    ...def,
    description: withSecret(def.description, opts.returnsSecret),
    annotations: { ...READ_ANNOTATIONS },
  };
}

export function readList(name: string, path: string, description: string, opts: ReadOptions = {}): ToolDefinition {
  return {
    name,
    description: withSecret(description, opts.returnsSecret),
    annotations: { ...READ_ANNOTATIONS },
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

export function readOne(
  name: string,
  prefix: string,
  description: string,
  idKey = 'id',
  opts: ReadOptions = {},
): ToolDefinition {
  return {
    name,
    description: withSecret(description, opts.returnsSecret),
    annotations: { ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        [idKey]: { type: 'string', description: `Resource id from ${opts.idSource ?? 'the matching list_* tool'}.` },
      },
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
  returnsSecret?: string;
}): ToolDefinition {
  return {
    name: opts.name,
    description: withSecret(opts.description, opts.returnsSecret),
    annotations: { ...READ_ANNOTATIONS },
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
// APIError -> errorResult contract as the read factories, plus what reads
// never need:
//   1. runtime input validation via a per-tool `.strict()` zod schema (the
//      advertised JSON Schema is what the agent sees; the zod schema is the
//      belt-and-suspenders guard at call time);
//   2. ONE safety classification per tool (`safety`), from which the factory
//      derives everything safety-related so no tool hand-writes it:
//        - the confirm gate: every kind except `plain` injects a required
//          `confirm` boolean and REFUSES (with no HTTP request) unless the
//          caller passes confirm:true;
//        - the refusal message and the `confirm` property description, both
//          naming the tool-specific `reason`;
//        - one standardized trailing "Safety: ..." sentence on the description;
//        - the MCP annotations (readOnlyHint:false, openWorldHint:true, and
//          destructiveHint for destructive + disruptive kinds).
//   3. optional secret marking: `returnsSecret` (the result holds a live
//      credential) and `acceptsSecret` (an input is a credential) append the
//      standardized SECURITY sentences.
//   4. optional Idempotency-Key support (`idempotent: true`, POST only, and only
//      for a route the API covers; index.test.ts pins that the flag matches
//      idempotency.ts): an optional `idempotency_key` input, sent as the header;
//      the client generates a key when it is absent, retries safely, and reports
//      a replay, which this factory turns into a note for the agent.

type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type GatedKind = 'spends' | 'destructive' | 'disruptive' | 'sensitive';
export type SafetyKind = 'plain' | GatedKind;

/**
 * plain: no charge, nothing torn down, runs without confirmation.
 * spends: charges money. destructive: irreversible teardown or loss.
 * disruptive: interrupts something running or locks someone out, reversibly.
 * sensitive: grants access, changes ownership/legal data, or speaks for the user.
 *
 * `reason` is a short plain-English clause naming the concrete consequence,
 * written to read after "This ..." / "it ...", with no trailing period, e.g.
 * "powers the server off; everything running on it stops until it is started again".
 */
export type Safety = { kind: 'plain' } | { kind: GatedKind; reason: string };

// How each gated kind reads inside the refusal ("... was NOT executed because it ...").
const KIND_LABEL: Record<GatedKind, string> = {
  spends: 'it spends money',
  destructive: 'it is irreversible',
  disruptive: 'it is disruptive',
  sensitive: 'it is security-sensitive',
};

// The uppercase tag used in the trailing Safety sentence.
const KIND_TAG: Record<GatedKind, string> = {
  spends: 'SPENDS MONEY',
  destructive: 'IRREVERSIBLE',
  disruptive: 'DISRUPTIVE',
  sensitive: 'SECURITY-SENSITIVE',
};

export const PLAIN_SAFETY_SENTENCE =
  'Safety: plain write; no charge, nothing torn down, runs without confirmation.';

/** The standardized final sentence of every write tool's description. */
export function safetySentence(safety: Safety): string {
  if (safety.kind === 'plain') return PLAIN_SAFETY_SENTENCE;
  const approval =
    safety.kind === 'spends'
      ? 'Requires confirm:true, only after the user approved the cost (preview it first where a preview tool exists).'
      : 'Requires confirm:true, only after the user explicitly approved.';
  return `Safety: ${KIND_TAG[safety.kind]}; this ${safety.reason}. ${approval}`;
}

/** The refusal a gated tool returns (with NO request made) when confirm:true is missing. */
export function refusalMessage(name: string, safety: { kind: GatedKind; reason: string }): string {
  return (
    `${name} was NOT executed because ${KIND_LABEL[safety.kind]}: it ${safety.reason}. ` +
    'Re-call with confirm:true only after the user has explicitly approved.'
  );
}

/** The advertised `idempotency_key` input of every idempotent write tool. */
export const IDEMPOTENCY_KEY_PROPERTY = Object.freeze({
  type: 'string' as const,
  minLength: 1,
  maxLength: 255,
  pattern: '^[\\x20-\\x7E]+$',
  description:
    'Optional Idempotency-Key, 1 to 255 printable ASCII characters: reuse the same value if you retry this ' +
    'exact request, and the API runs it at most once (a retry gets the first answer back). Use a new value ' +
    'for a different request. Omit it and the server makes one key per call and retries once on a dropped ' +
    'connection with that same key.',
});

/** The note put before the result when the API replayed an earlier identical request. */
export function replayNote(info: ReplayInfo): string {
  const base =
    'Note: idempotent replay. The API answered with the stored result of an earlier identical request with ' +
    'the same Idempotency-Key; the operation ran once, not again.';
  if (info.secretsOmittedOnReplay.length === 0) return base;
  return (
    `${base} secretsOmittedOnReplay: ${JSON.stringify(info.secretsOmittedOnReplay)}. Those secrets were shown ` +
    'only in the first answer and cannot be shown again; if they were lost, replace the credential (for example reset the password or create a new key).'
  );
}

function confirmProperty(safety: { kind: GatedKind; reason: string }) {
  return {
    type: 'boolean' as const,
    description:
      `Set to true to execute. This tool ${safety.reason}; only pass true after the user has explicitly ` +
      'approved. Omit or false: the tool refuses and makes no API call.',
  };
}

export interface WriteToolOptions<S extends z.ZodTypeAny> {
  name: string;
  /** Domain description only: what it does, ids, scope literal. NO safety phrasing (the factory adds it). */
  description: string;
  method: WriteMethod;
  /** The single safety classification; everything gate/annotation/wording related derives from it. */
  safety: Safety;
  /** The result contains a live credential; names it for the SECURITY sentence. */
  returnsSecret?: string;
  /** An input is a live credential; names it for the never-echo SECURITY sentence. */
  acceptsSecret?: string;
  /** zod schema for the caller's DOMAIN args (never `confirm`; the factory owns that). */
  input: S;
  /** Advertised JSON Schema (closed). Do NOT list `confirm`; the factory injects it when gated. */
  inputSchema: ToolDefinition['inputSchema'];
  /** Build the request path; run EVERY dynamic segment through encodeSegment. */
  buildPath: (args: z.infer<S>) => string;
  /** Build the JSON body. Omit for no-body writes (DELETE, no-body POST). */
  buildBody?: (args: z.infer<S>) => unknown;
  /** Override result formatting (e.g. unwrap a returned credential). Default: jsonResult. */
  formatResult?: (data: unknown) => ToolCallResult;
  /**
   * POST only: the route honours Idempotency-Key (it is in idempotency.ts). Adds the
   * optional `idempotency_key` input and the safe-retry behaviour.
   */
  idempotent?: boolean;
}

export function writeTool<S extends z.ZodTypeAny>(
  opts: WriteToolOptions<S>,
): ToolDefinition {
  const { safety } = opts;
  if (safety.kind !== 'plain' && !safety.reason?.trim()) {
    throw new Error(`${opts.name}: a ${safety.kind} tool needs a non-empty safety reason`);
  }
  if (opts.idempotent && opts.method !== 'POST') {
    throw new Error(`${opts.name}: only a POST tool can be idempotent`);
  }
  const gated = safety.kind === 'plain' ? null : safety;

  // Advertise `idempotency_key` when the route honours it, and `confirm` only
  // when the gate is on.
  let inputSchema: ToolDefinition['inputSchema'] = opts.inputSchema;
  if (opts.idempotent) {
    inputSchema = {
      ...inputSchema,
      properties: { ...inputSchema.properties, idempotency_key: { ...IDEMPOTENCY_KEY_PROPERTY } },
    };
  }
  if (gated) {
    inputSchema = {
      ...inputSchema,
      properties: { ...inputSchema.properties, confirm: confirmProperty(gated) },
      required: [...(inputSchema.required ?? []), 'confirm'],
    };
  }

  const description = [
    opts.description,
    opts.acceptsSecret ? inputSecretSentence(opts.acceptsSecret) : '',
    opts.returnsSecret ? secretSentence(opts.returnsSecret) : '',
    safetySentence(safety),
  ]
    .filter(Boolean)
    .join(' ');

  return {
    name: opts.name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: safety.kind === 'destructive' || safety.kind === 'disruptive',
      openWorldHint: true,
    },
    async handler(client, args) {
      try {
        // Separate the factory-owned confirm flag (and, for an idempotent tool,
        // idempotency_key) from the domain args so the per-tool .strict() zod
        // schema never sees them. A non-idempotent tool leaves idempotency_key
        // in place, where .strict() rejects it as unknown.
        const { confirm, ...rest } = args as { confirm?: unknown } & Record<string, unknown>;
        let domainArgs: Record<string, unknown> = rest;
        let idempotencyKey: unknown;
        if (opts.idempotent) {
          ({ idempotency_key: idempotencyKey, ...domainArgs } = rest);
        }

        // 1. Runtime input validation (in addition to the advertised JSON Schema).
        const parsed = opts.input.safeParse(domainArgs);
        if (!parsed.success) {
          return errorResult(`Invalid input for ${opts.name}: ${formatZodError(parsed.error)}`);
        }

        if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
          return errorResult(`Invalid input for ${opts.name}: idempotency_key must be 1 to 255 printable ASCII characters`);
        }

        // 2. Confirm gate: refuse with NO request when required and not granted.
        //    It runs before any key is generated or any request is made.
        if (gated && confirm !== true) {
          return errorResult(refusalMessage(opts.name, gated));
        }

        // 3. Build path/body. encodeSegment throws on a traversal token → caught
        //    below → errorResult, so NO request goes out for a bad segment.
        const path = opts.buildPath(parsed.data);
        const body = opts.buildBody ? opts.buildBody(parsed.data) : undefined;

        // 4. Dispatch. An idempotent POST goes through the client's Idempotency-Key
        //    path (header, generated key, safe retry); the client itself refuses to
        //    send the header to a route outside idempotency.ts.
        let replay: ReplayInfo | undefined;
        const data =
          opts.idempotent && isIdempotentPostPath(path)
            ? await client.post(path, body, {
                idempotent: {
                  key: idempotencyKey as string | undefined,
                  onReplay: (info) => { replay = info; },
                },
              })
            : await callMethod(client, opts.method, path, body);
        const result = opts.formatResult ? opts.formatResult(data) : jsonResult(data);
        if (!replay) return result;
        return { ...result, content: [{ type: 'text', text: replayNote(replay) }, ...result.content] };
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
