// AI Sandboxes READ tools: list and inspect sandboxes, list the templates with
// their hourly price, read a file from a sandbox, and read a run-mode sandbox's
// logs. Every route is services:read; shapes mirror
// api/src/routes/v1-sandboxes.ts. A sandbox you do not own answers 404, exactly
// like a missing one. Until AI Sandboxes launch on an account's region every
// route answers 503 "AI Sandboxes are not available yet.", passed through as is.

import { APIError } from '../client.js';
import { readList, readOne, readTool, defineReadTool, encodeSegment } from './factories.js';
import { type ToolDefinition, textResult, errorResult } from './types.js';

/** The `id` input every per-sandbox tool takes. */
export const SANDBOX_ID_PROPERTY = Object.freeze({
  type: 'string' as const,
  description: 'Sandbox id from list_sandboxes (or the id create_sandbox returned), e.g. "sbx-0a1b2c3d".',
});

/** The `path` input of the file tools: an absolute path inside the sandbox. */
export const SANDBOX_FILE_PATH_PROPERTY = Object.freeze({
  type: 'string' as const,
  minLength: 1,
  maxLength: 4096,
  pattern: '^/',
  description: 'Absolute file path inside the sandbox (starts with /), e.g. "/home/user/out.csv".',
});

/** Throws (no request made) unless `path` is an absolute path without NUL, as the API requires. */
export function checkSandboxPath(path: unknown): string {
  if (typeof path !== 'string' || path === '' || path.length > 4096) {
    throw new Error('Invalid path value: an absolute file path of 1 to 4096 characters is required');
  }
  if (!path.startsWith('/')) throw new Error('Invalid path value: path must be absolute (start with /)');
  if (path.includes('\0')) throw new Error('Invalid path value: path must not contain NUL');
  return path;
}

export const listSandboxes = readList(
  'list_sandboxes',
  '/v1/sandboxes',
  'List the AI Sandboxes this account owns: id, name, status, template, image, labels, envKeys (the NAMES of its environment variables; values are never returned), networkBlocked, run (null = interactive), createdAt, timeoutMs and expiresAt (when it stops and is deleted automatically). An exited run-mode sandbox stays listed for 24 hours. Requires scope services:read. Use to find a sandbox id, or to check what is still running (and billed) before creating another; after a create that failed with a timeout or 503, list first: the sandbox may exist.',
);

export const listSandboxTemplates = readList(
  'list_sandbox_templates',
  '/v1/sandboxes/templates',
  'List the templates a sandbox can be created from (python, node, base) with their size (vcpu, ramGb, diskGb), the image each runs, and the price per hour in EUR and USD (billed per second). Requires scope services:read. Use to pick the template for create_sandbox and to tell the user what it costs before creating one.',
);

export const getSandbox = readOne(
  'get_sandbox',
  '/v1/sandboxes',
  'Get one AI Sandbox: status (and statusReason while an image is pulling or failed to pull), template, image, name, labels, envKeys (names only, never values), networkBlocked, run, createdAt, timeoutMs and expiresAt. Requires scope services:read. Use after create_sandbox to wait until it is running, or to see when it expires.',
  'id',
  { idSource: 'list_sandboxes' },
);

export const readSandboxFile = readTool({
  name: 'read_sandbox_file',
  description:
    'Read one file from a sandbox by absolute path, up to 25 MiB. Returns { path, content, encoding? }: valid UTF-8 text comes back as text; a binary file (invalid UTF-8 or containing NUL), or text dense in control characters, comes back as base64 with encoding "base64", so always check encoding. Requires scope services:read. At most 4 exec and file calls run at once per account (more answer 429 RATE_LIMITED with Retry-After).',
  inputSchema: {
    type: 'object',
    properties: { id: SANDBOX_ID_PROPERTY, path: SANDBOX_FILE_PATH_PROPERTY },
    required: ['id', 'path'],
    additionalProperties: false,
  },
  buildPath: (args) => {
    const id = encodeSegment(args.id, 'id');
    const path = checkSandboxPath(args.path);
    return `/v1/sandboxes/${id}/files?${new URLSearchParams({ path }).toString()}`;
  },
});

const LOGS_MAX_TAIL = 5000;

export const getSandboxLogs: ToolDefinition = defineReadTool({
  name: 'get_sandbox_logs',
  description:
    'Read the last lines of a sandbox program\'s output (stdout and stderr) as plain text, returned verbatim. Made for run-mode sandboxes (created with run): while the sandbox exists the lines come from its container (none before the program starts); after a run-mode sandbox exited, from what the API kept, the last 256 KiB for 24 hours. A 404 means the logs are gone (unknown or deleted sandbox, or kept logs expired). A 503 "Logs are not available yet." means the sandbox cluster does not allow log reads yet; read output with run_sandbox_command instead. Requires scope services:read.',
  inputSchema: {
    type: 'object',
    properties: {
      id: SANDBOX_ID_PROPERTY,
      tail: {
        type: 'integer',
        minimum: 1,
        maximum: LOGS_MAX_TAIL,
        description: 'How many lines from the end (1-5000, default 200).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = encodeSegment(args.id, 'id');
      const { tail } = args;
      if (tail !== undefined && (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 1 || tail > LOGS_MAX_TAIL)) {
        return errorResult(`Invalid input for get_sandbox_logs: tail must be a whole number from 1 to ${LOGS_MAX_TAIL}`);
      }
      const path = tail === undefined ? `/v1/sandboxes/${id}/logs` : `/v1/sandboxes/${id}/logs?tail=${tail}`;
      const text = await client.getText(path);
      return text === ''
        ? textResult('No log lines yet: the program has not written any output, or has not started.')
        : textResult(text);
    } catch (e) {
      if (e instanceof APIError && e.status === 503) {
        return errorResult(
          `${e.message} (HTTP 503: the logs of this sandbox cannot be read right now, so they are not available yet; ` +
            'the sandbox itself is not affected. Retry later, or read its output with run_sandbox_command.)',
        );
      }
      if (e instanceof APIError && e.status === 404) {
        return errorResult(
          `${e.message} (HTTP 404: the logs are gone. The sandbox is unknown or deleted, or it is a run-mode sandbox ` +
            'that ended more than 24 hours ago and its kept logs expired. They cannot be recovered.)',
        );
      }
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
});
