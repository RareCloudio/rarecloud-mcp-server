// AI Sandboxes WRITE tools: create and delete a sandbox, run code or a shell
// command in it, and write a file into it. All scope services:write; shapes
// mirror api/src/routes/v1-sandboxes.ts and the create options in
// api/src/lib/sandboxes/createOptions.ts.
//
// Safety kinds:
//   - create_sandbox is `spends` (billed per second while it runs) and
//     idempotent (POST /v1/sandboxes is a covered route).
//   - delete_sandbox is `destructive`: everything inside the sandbox is lost.
//   - run_sandbox_code, run_sandbox_command and write_sandbox_file are `plain`.
//     They act only inside a sandbox the agent created for this purpose, add no
//     charge of their own (the sandbox is billed by time either way) and tear
//     down no account resource. write_sandbox_file overwrites a file, but so can
//     any command, and gating one of the three while the other two run freely
//     would add a prompt without adding safety. That matches set_service_tags
//     (a PUT that replaces in place) being plain.
//
// No tool for POST /v1/sandboxes/{id}/ports/{port}: preview URLs are not part of
// v1 and the API answers 501 by product decision.
//
// env values may be secrets: they are sent to the API and never come back. The
// API returns only their names (envKeys); create_sandbox strips an `env` field
// from the result anyway, and a local refusal names a bad entry by position,
// never by key or value.

import { z } from 'zod';
import { type ToolDefinition, jsonResult } from './types.js';
import { writeTool, encodeSegment } from './factories.js';
import { SANDBOX_ID_PROPERTY, SANDBOX_FILE_PATH_PROPERTY } from './sandboxes.js';

const MAX_LIFETIME_MS = 3_600_000;
const RUN_MAX_ELEMENTS = 64;
const RUN_MAX_ELEMENT_LENGTH = 4096;
const NAME_PATTERN = '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$';
const IMAGE_PATTERN = '^[a-zA-Z0-9][\\w./:@-]*$';
const ENV_MAX_VARS = 50;
const LABELS_MAX = 20;

const sandboxId = z.string().min(1);

const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), { message: 'path must be absolute (start with /)' })
  .refine((p) => !p.includes('\0'), { message: 'path must not contain NUL' });

// Env entries are checked by position so no message carries a key or a value
// (a key can hold a pasted secret too). The API runs its own full check.
const envSchema = z.record(z.string(), z.unknown()).superRefine((env, ctx) => {
  const keys = Object.keys(env);
  if (keys.length > ENV_MAX_VARS) {
    ctx.addIssue({ code: 'custom', message: `at most ${ENV_MAX_VARS} environment variables` });
  }
  keys.forEach((k, i) => {
    if (typeof env[k] !== 'string') {
      ctx.addIssue({ code: 'custom', message: `the value of environment variable #${i + 1} must be a string` });
    }
  });
}).transform((env) => env as Record<string, string>);

const labelsSchema = z.record(z.string(), z.string().max(256)).refine((l) => Object.keys(l).length <= LABELS_MAX, {
  message: `at most ${LABELS_MAX} labels`,
});

const argv = z.array(z.string().max(RUN_MAX_ELEMENT_LENGTH)).min(1).max(RUN_MAX_ELEMENTS);

const argvProperty = (description: string) => ({
  type: 'array',
  minItems: 1,
  maxItems: RUN_MAX_ELEMENTS,
  items: { type: 'string', maxLength: RUN_MAX_ELEMENT_LENGTH },
  description,
});

/** The sandbox as the API returned it, minus any `env` field: env values never reach the agent. */
function withoutEnvValues(data: unknown) {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'env' in data) {
    const { env: _env, ...rest } = data as Record<string, unknown>;
    return jsonResult(rest);
  }
  return jsonResult(data);
}

export const createSandbox: ToolDefinition = writeTool({
  name: 'create_sandbox',
  description:
    'Create an isolated AI Sandbox (a short-lived container for running code). Requires scope services:write. ' +
    'All inputs are optional: template (default python) picks size and price, see list_sandbox_templates; ' +
    'image runs a custom public image or one from your RareCloud registry instead; timeoutMs is the lifetime ' +
    '(default 5 minutes, max 1 hour), after which it stops and is deleted at expiresAt; name, labels, env and ' +
    'networkBlocked are fixed at creation. Without run the sandbox waits for run_sandbox_code, ' +
    'run_sandbox_command and the file tools; with run it starts a program by itself and ends when it exits ' +
    '(read its output with get_sandbox_logs). Billed per second from when it starts running until it is ' +
    'deleted or expires, on the monthly cloud invoice; an account that cannot pay is refused (400 with an ' +
    'add-funds link), and at most 8 run at once by default (409 QUOTA_EXCEEDED). Returns the sandbox (id, ' +
    'status, expiresAt, envKeys with the NAMES of the env variables, never the values); poll get_sandbox until ' +
    'status is running. A 503 after a timeout does not prove nothing was created: call list_sandboxes before ' +
    'creating again, and delete the one you do not need.',
  method: 'POST',
  idempotent: true,
  safety: {
    kind: 'spends',
    reason:
      'creates a sandbox billed per second from when it starts running until it is deleted or its lifetime (timeoutMs, default 5 minutes, max 1 hour) ends',
  },
  acceptsSecret: 'the env values',
  input: z
    .object({
      template: z.string().min(1).max(64).optional(),
      image: z.string().min(1).max(512).regex(new RegExp(IMAGE_PATTERN), 'invalid image reference').optional(),
      timeoutMs: z.number().int().min(1000).max(MAX_LIFETIME_MS).optional(),
      name: z.string().regex(new RegExp(NAME_PATTERN), 'name must be 1-63 lowercase letters, digits or dashes').optional(),
      env: envSchema.optional(),
      labels: labelsSchema.optional(),
      networkBlocked: z.boolean().optional(),
      run: z.object({ entrypoint: argv.optional(), command: argv.optional() }).strict().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      template: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Template name from list_sandbox_templates: python (default, data science), node, or base (shell only). Drives size and price, also with a custom image.',
      },
      image: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        pattern: IMAGE_PATTERN,
        description:
          'Optional custom image instead of the template\'s. A public image (e.g. "nginx:1.27", "ghcr.io/acme/app:tag") from Docker Hub, ghcr.io, quay.io, registry.k8s.io, public.ecr.aws, gcr.io or mcr.microsoft.com, or "<registry hostname>/<your handle>/<repository>:<tag>" (or @sha256:<digest>) from your own RareCloud registry; "latest" alone is refused for a registry image.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1000,
        maximum: MAX_LIFETIME_MS,
        description: 'Lifetime in milliseconds (default 300000 = 5 minutes, max 3600000 = 1 hour). Values below 60000 are raised to 60000. The sandbox stops and is deleted at expiresAt.',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 63,
        pattern: NAME_PATTERN,
        description: 'Optional name: 1-63 lowercase letters, digits and dashes, not starting or ending with a dash. Unique among your live sandboxes (409 name_taken otherwise).',
      },
      env: {
        type: 'object',
        maxProperties: ENV_MAX_VARS,
        additionalProperties: { type: 'string', maxLength: 8192 },
        description: 'Optional environment variables: at most 50, names matching ^[A-Za-z_][A-Za-z0-9_]{0,127}$, each value at most 8192 bytes, 65536 in total. Values are write-only (they may be secrets): never returned, only their names (envKeys).',
      },
      labels: {
        type: 'object',
        maxProperties: LABELS_MAX,
        additionalProperties: { type: 'string', maxLength: 256 },
        description: 'Optional labels: at most 20, lowercase keys of 1-63 characters, values of at most 256 characters. Not secret.',
      },
      networkBlocked: {
        type: 'boolean',
        description: 'True creates the sandbox with outbound network access off (default false). Cannot be changed later.',
      },
      run: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entrypoint: argvProperty('Replaces the image\'s ENTRYPOINT. Without command, the image\'s CMD is not used either.'),
          command: argvProperty('Replaces the image\'s CMD; the image\'s ENTRYPOINT still runs, with these as its arguments.'),
        },
        description:
          'Run mode: the sandbox starts a program by itself instead of waiting for commands, and ends when it exits (no restart). {} runs the image\'s own ENTRYPOINT and CMD. With a template (no image) command is required. At most 64 elements per list, 4096 bytes each, 32 KiB in total. Read the output with get_sandbox_logs.',
      },
    },
    additionalProperties: false,
  },
  buildPath: () => '/v1/sandboxes',
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    for (const k of ['template', 'image', 'timeoutMs', 'name', 'env', 'labels', 'networkBlocked', 'run'] as const) {
      if (a[k] !== undefined) body[k] = a[k];
    }
    return body;
  },
  formatResult: withoutEnvValues,
});

export const deleteSandbox: ToolDefinition = writeTool({
  name: 'delete_sandbox',
  description:
    'Terminate and remove an AI Sandbox. Requires scope services:write. Billing stops when the delete is ' +
    'accepted. Deleting an exited run-mode sandbox also removes its kept logs. A 503 means the delete could not ' +
    'be recorded and the sandbox keeps running (and billing): retry. id comes from list_sandboxes.',
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: 'terminates the sandbox and deletes everything in it (its files, running processes and kept logs); it cannot be recovered',
  },
  input: z.object({ id: sandboxId }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: SANDBOX_ID_PROPERTY },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/sandboxes/${encodeSegment(a.id, 'id')}`,
});

const EXEC_LIMITS =
  'Output is capped: stdout and stderr together stop at 10 MiB, and a call stops after 300 seconds (or at the ' +
  'sandbox expiresAt, if sooner); a cut-off result has truncated: true (and timedOut: true for the time limit) ' +
  'and exitCode -1. At most 4 exec and file calls run at once per account (more answer 429 RATE_LIMITED with ' +
  'Retry-After).';

export const runSandboxCode: ToolDefinition = writeTool({
  name: 'run_sandbox_code',
  description:
    'Run a code snippet inside an AI Sandbox (python3 -c or node -e) and return { stdout, stderr, exitCode, ' +
    `results? }. Requires scope services:write. State on disk persists between calls; each call is a new process. ${EXEC_LIMITS} ` +
    'id comes from list_sandboxes.',
  method: 'POST',
  safety: { kind: 'plain' },
  input: z
    .object({
      id: sandboxId,
      language: z.enum(['python', 'node']),
      code: z.string().min(1).max(100_000),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: SANDBOX_ID_PROPERTY,
      language: { type: 'string', enum: ['python', 'node'], description: 'python (python3 -c) or node (node -e).' },
      code: { type: 'string', minLength: 1, maxLength: 100000, description: 'The source code to run (at most 100000 characters).' },
    },
    required: ['id', 'language', 'code'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/sandboxes/${encodeSegment(a.id, 'id')}/run_code`,
  buildBody: (a) => ({ language: a.language, code: a.code }),
});

export const runSandboxCommand: ToolDefinition = writeTool({
  name: 'run_sandbox_command',
  description:
    'Run a shell command inside an AI Sandbox (sh -c) and return { stdout, stderr, exitCode }. Requires scope ' +
    `services:write. Chain several commands in one cmd with && or ;. ${EXEC_LIMITS} id comes from list_sandboxes.`,
  method: 'POST',
  safety: { kind: 'plain' },
  input: z.object({ id: sandboxId, cmd: z.string().min(1).max(10_000) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: SANDBOX_ID_PROPERTY,
      cmd: { type: 'string', minLength: 1, maxLength: 10000, description: 'The shell command line, run with sh -c (at most 10000 characters).' },
    },
    required: ['id', 'cmd'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/sandboxes/${encodeSegment(a.id, 'id')}/commands`,
  buildBody: (a) => ({ cmd: a.cmd }),
});

export const writeSandboxFile: ToolDefinition = writeTool({
  name: 'write_sandbox_file',
  description:
    'Create or overwrite one file inside an AI Sandbox (parent directories are created). Requires scope ' +
    'services:write. content is UTF-8 text, or base64 with encoding "base64" for a binary file (send text heavy ' +
    'in control characters as base64 too); base64 must be canonical. At most 25 MiB of decoded bytes (413 ' +
    'PAYLOAD_TOO_LARGE above it). At most 4 exec and file calls run at once per account. id comes from ' +
    'list_sandboxes.',
  method: 'PUT',
  safety: { kind: 'plain' },
  input: z
    .object({
      id: sandboxId,
      path: filePath,
      content: z.string(),
      encoding: z.enum(['base64']).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: SANDBOX_ID_PROPERTY,
      path: SANDBOX_FILE_PATH_PROPERTY,
      content: { type: 'string', description: 'File content: UTF-8 text, or base64 when encoding is "base64".' },
      encoding: { type: 'string', enum: ['base64'], description: 'Optional. "base64": content is base64 and the decoded bytes are written.' },
    },
    required: ['id', 'path', 'content'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/sandboxes/${encodeSegment(a.id, 'id')}/files`,
  buildBody: (a) => {
    const body: Record<string, unknown> = { path: a.path, content: a.content };
    if (a.encoding !== undefined) body.encoding = a.encoding;
    return body;
  },
});
