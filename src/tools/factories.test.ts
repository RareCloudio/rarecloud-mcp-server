// Unit tests for the shared tool factories. We inject a fake client whose
// `get` records the path it was called with (and optionally throws), so we
// can assert on path construction, id/query encoding, and the uniform
// APIError -> errorResult mapping without any network or real client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { readList, readOne, readTool, encodeSegment, writeTool, defineReadTool, secretSentence, inputSecretSentence } from './factories.js';
import { APIError, type RareCloudClient } from '../client.js';
import { textResult, type ToolCallResult } from './types.js';

// A minimal stand-in for RareCloudClient exposing only `get`, which is all
// the read factories use. `onGet` receives the path and returns the data
// (or throws to exercise the error path).
function fakeClient(onGet: (path: string) => unknown): { client: RareCloudClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async get(path: string) {
      calls.push(path);
      return onGet(path);
    },
  } as unknown as RareCloudClient;
  return { client, calls };
}

// Pull the single text block out of a ToolCallResult for assertions.
function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

// --- readList -------------------------------------------------------------

test('readList: shape (name, description, empty closed schema)', () => {
  const tool = readList('list_things', '/v1/things', 'List the things.');
  assert.equal(tool.name, 'list_things');
  assert.equal(tool.description, 'List the things.');
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
});

test('readList: handler GETs the fixed path and JSON-encodes the data', async () => {
  const { client, calls } = fakeClient(() => [{ id: 'svc-123' }]);
  const tool = readList('list_things', '/v1/things', 'List the things.');
  const result = await tool.handler(client, {});
  assert.deepEqual(calls, ['/v1/things']);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: 'svc-123' }]);
});

test('readList: APIError maps to errorResult with the API message', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'read scope required' });
  });
  const tool = readList('list_things', '/v1/things', 'List the things.');
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] read scope required');
});

// --- readOne --------------------------------------------------------------

test('readOne: default idKey "id" — required, closed schema', () => {
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  assert.equal(tool.name, 'get_thing');
  assert.deepEqual(tool.inputSchema.required, ['id']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok('id' in tool.inputSchema.properties);
});

test('readOne: custom idKey drives both the property and the required list', () => {
  const tool = readOne('get_domain', '/v1/domains', 'Get one domain.', 'domain_id');
  assert.deepEqual(tool.inputSchema.required, ['domain_id']);
  assert.ok('domain_id' in tool.inputSchema.properties);
});

test('readOne: URL-encodes the id into the path', async () => {
  const { client, calls } = fakeClient(() => ({ id: 'a b/c' }));
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  await tool.handler(client, { id: 'a b/c' });
  assert.deepEqual(calls, ['/v1/things/a%20b%2Fc']);
});

test('readOne: missing id is rejected before any request (empty segment guard)', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid id value');
  assert.deepEqual(calls, [], 'no request may reach the client for an empty id');
});

test('readOne: a "." id is rejected before any request (dot-segment guard)', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  const result = await tool.handler(client, { id: '.' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a "." id');
});

test('readOne: a ".." id is rejected before any request (dot-segment guard, custom idKey)', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const tool = readOne('get_domain', '/v1/domains', 'Get one domain.', 'domain_id');
  const result = await tool.handler(client, { domain_id: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid domain_id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." id');
});

test('readOne: APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'no such thing' });
  });
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  const result = await tool.handler(client, { id: 'svc-123' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [NOT_FOUND] no such thing');
});

// --- readTool -------------------------------------------------------------

test('readTool: passes through name/description/inputSchema', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false };
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: schema,
    buildPath: () => '/v1/things',
  });
  assert.equal(tool.name, 'search_things');
  assert.equal(tool.description, 'Search the things.');
  assert.deepEqual(tool.inputSchema, schema);
});

test('readTool: handler GETs whatever buildPath returns (incl. encoded query)', async () => {
  const { client, calls } = fakeClient(() => [{ id: 'svc-123' }]);
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    buildPath: (args) => `/v1/things?q=${encodeURIComponent(String(args.q))}`,
  });
  const result = await tool.handler(client, { q: 'a b&c' });
  assert.deepEqual(calls, ['/v1/things?q=a%20b%26c']);
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: 'svc-123' }]);
});

test('readTool: APIError maps to errorResult with the API message', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'BAD_REQUEST', message: 'q is required' });
  });
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/things',
  });
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [BAD_REQUEST] q is required');
});

test('readTool: a non-APIError still maps to errorResult via its message', async () => {
  const { client } = fakeClient(() => {
    throw new Error('socket hang up');
  });
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/things',
  });
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: socket hang up');
});

// readTool buildPath callers that embed a path segment run it through
// encodeSegment. When that segment is a traversal token, encodeSegment throws
// inside buildPath, which the handler's try/catch maps to an errorResult —
// so client.get is never reached.
test('readTool: a ".." path segment via encodeSegment is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({ ok: true }));
  const tool = readTool({
    name: 'get_thing_detail',
    description: 'Get a thing detail.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    buildPath: (args) => `/v1/things/${encodeSegment(args.id, 'id')}/detail`,
  });
  const result = await tool.handler(client, { id: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." segment');
});

// --- encodeSegment (dot-segment / empty guard for path segments) ----------

test('encodeSegment: passes valid values through URL-encoding (unchanged for good input)', () => {
  assert.equal(encodeSegment('svc-123', 'service_id'), 'svc-123');
  assert.equal(encodeSegment('a b/c', 'service_id'), 'a%20b%2Fc');
  // A value merely CONTAINING dots (not exactly "." / "..") is fine.
  assert.equal(encodeSegment('v1.2.3', 'sku'), 'v1.2.3');
  assert.equal(encodeSegment('..foo', 'id'), '..foo');
});

test('encodeSegment: rejects "." "." ".." and empty with a named error', () => {
  for (const bad of ['', '.', '..']) {
    assert.throws(
      () => encodeSegment(bad, 'service_id'),
      (e: unknown) => e instanceof Error && e.message === 'Invalid service_id value',
      `expected encodeSegment(${JSON.stringify(bad)}) to throw`,
    );
  }
});

test('encodeSegment: null / undefined coerce to empty and are rejected', () => {
  assert.throws(() => encodeSegment(undefined, 'id'), /Invalid id value/);
  assert.throws(() => encodeSegment(null, 'id'), /Invalid id value/);
});

// --- writeTool (Parity Phase B) -------------------------------------------

// A fake client that records method+path+body across all four write verbs (no
// network). DELETE records no `body` key so tests can assert it carries none.
function fakeWriteClient(
  impl: (m: string, p: string, b?: unknown) => unknown = () => ({ ok: true }),
): { client: RareCloudClient; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const withBody = (method: string) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return impl(method, path, body);
  };
  const client = {
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    async delete(path: string) {
      calls.push({ method: 'DELETE', path });
      return impl('DELETE', path);
    },
  } as unknown as RareCloudClient;
  return { client, calls };
}

// (a) advertised inputSchema excludes confirm for a plain write.
test('writeTool: advertised inputSchema excludes confirm for a plain write', () => {
  const tool = writeTool({
    name: 'set_x',
    description: 'Set x.',
    method: 'POST',
    safety: { kind: 'plain' },
    input: z.object({ id: z.string().min(1) }).strict(),
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    buildPath: (a) => `/v1/x/${encodeSegment(a.id, 'id')}`,
  });
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
  assert.ok(!('confirm' in tool.inputSchema.properties), 'confirm must not be advertised when un-gated');
  assert.deepEqual(tool.inputSchema.required, ['id']);
});

// (b) every non-plain kind injects a required confirm boolean whose
//     description carries the tool-specific reason.
for (const kind of ['spends', 'destructive', 'disruptive', 'sensitive'] as const) {
  test(`writeTool: kind=${kind} injects a required confirm whose description names the reason`, () => {
    const tool = writeTool({
      name: 'act_x',
      description: 'Act on x.',
      method: 'POST',
      safety: { kind, reason: 'does the very specific thing' },
      input: z.object({ id: z.string().min(1) }).strict(),
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      buildPath: (a) => `/v1/x/${encodeSegment(a.id, 'id')}`,
    });
    const confirmProp = (tool.inputSchema.properties as Record<string, { type?: string; description?: string }>).confirm;
    assert.equal(confirmProp.type, 'boolean');
    assert.match(confirmProp.description ?? '', /does the very specific thing/);
    assert.doesNotMatch(confirmProp.description ?? '', /and\/or is irreversible/, 'no generic spend-or-destroy text');
    assert.ok(tool.inputSchema.required?.includes('confirm'), 'confirm must be required when gated');
    assert.ok(tool.inputSchema.required?.includes('id'), 'domain required fields are preserved');
  });
}

// (c) annotations are derived from the kind, on every write tool.
test('writeTool: annotations derived from the safety kind', () => {
  const base = {
    name: 'x',
    description: 'x.',
    method: 'POST' as const,
    input: z.object({}).strict(),
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    buildPath: () => '/v1/x',
  };
  const expected: Record<string, boolean> = {
    plain: false,
    spends: false,
    sensitive: false,
    destructive: true,
    disruptive: true,
  };
  for (const [kind, destructiveHint] of Object.entries(expected)) {
    const safety = kind === 'plain' ? { kind: 'plain' as const } : { kind: kind as 'spends', reason: 'r' };
    const tool = writeTool({ ...base, safety });
    assert.deepEqual(
      tool.annotations,
      { readOnlyHint: false, destructiveHint, openWorldHint: true },
      `annotations for kind=${kind}`,
    );
  }
});

// (c2) the description ends with exactly one standardized Safety sentence.
test('writeTool: description gets exactly one standardized trailing Safety sentence per kind', () => {
  const base = {
    name: 'x',
    description: 'Does x. Requires scope services:write.',
    method: 'POST' as const,
    input: z.object({}).strict(),
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    buildPath: () => '/v1/x',
  };
  const plain = writeTool({ ...base, safety: { kind: 'plain' } });
  assert.ok(plain.description.startsWith('Does x. Requires scope services:write. '));
  assert.ok(plain.description.endsWith('Safety: plain write; no charge, nothing torn down, runs without confirmation.'));
  const labels = {
    spends: 'Safety: SPENDS MONEY; this costs a lot.',
    destructive: 'Safety: IRREVERSIBLE; this costs a lot.',
    disruptive: 'Safety: DISRUPTIVE; this costs a lot.',
    sensitive: 'Safety: SECURITY-SENSITIVE; this costs a lot.',
  } as const;
  for (const [kind, prefix] of Object.entries(labels)) {
    const tool = writeTool({ ...base, safety: { kind: kind as 'spends', reason: 'costs a lot' } });
    const tail = tool.description.slice(tool.description.indexOf('Safety:'));
    assert.ok(tail.startsWith(prefix), `${kind}: ${tail}`);
    assert.match(tail, /Requires confirm:true/);
    assert.equal(tool.description.split('Safety:').length - 1, 1, 'exactly one Safety sentence');
  }
});

// (c3) returnsSecret / acceptsSecret append the standard SECURITY sentences
//      (before the trailing Safety sentence).
test('writeTool: returnsSecret appends the standard SECURITY sentence before Safety', () => {
  const tool = writeTool({
    name: 'x',
    description: 'Does x.',
    method: 'POST',
    safety: { kind: 'plain' },
    returnsSecret: 'the magic token',
    input: z.object({}).strict(),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/x',
  });
  assert.ok(tool.description.includes(secretSentence('the magic token')));
  assert.match(secretSentence('the magic token'), /^SECURITY: the result contains the magic token, a live credential\./);
  assert.ok(tool.description.indexOf('SECURITY:') < tool.description.indexOf('Safety:'));
});

test('writeTool: acceptsSecret appends the never-echo input sentence', () => {
  const tool = writeTool({
    name: 'x',
    description: 'Does x.',
    method: 'POST',
    safety: { kind: 'plain' },
    acceptsSecret: 'the password',
    input: z.object({}).strict(),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/x',
  });
  assert.ok(tool.description.includes(inputSecretSentence('the password')));
  assert.match(inputSecretSentence('the password'), /^SECURITY: treat the password you pass in as a secret/);
  assert.match(inputSecretSentence('the password'), /never echo the value back/);
});

// (d) a gated handler refuses without confirm, names the reason, and issues NO request.
for (const [kind, label] of [
  ['spends', /spends money/],
  ['destructive', /irreversible/],
  ['disruptive', /disruptive/],
  ['sensitive', /security-sensitive/],
] as const) {
  test(`writeTool: kind=${kind} refuses without confirm, names the reason, makes NO request`, async () => {
    const { client, calls } = fakeWriteClient();
    const tool = writeTool({
      name: 'act_now',
      description: 'Act.',
      method: 'POST',
      safety: { kind, reason: 'turns the lights off' },
      input: z.object({}).strict(),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      buildPath: () => '/v1/act',
      buildBody: () => ({ amount: 1 }),
    });
    for (const args of [{}, { confirm: false }, { confirm: 'true' }]) {
      const result = await tool.handler(client, args);
      assert.equal(result.isError, true);
      const text = textOf(result);
      assert.match(text, /act_now was NOT executed/);
      assert.match(text, label);
      assert.match(text, /it turns the lights off/);
      assert.match(text, /confirm:true/);
    }
    assert.deepEqual(calls, [], 'a refused gated tool must issue no request');
  });
}

// --- read factories: annotations + returnsSecret --------------------------

test('read factories + defineReadTool: every read carries the read-only annotations', () => {
  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const list = readList('list_x', '/v1/x', 'List x.');
  const one = readOne('get_x', '/v1/x', 'Get x.');
  const tool = readTool({
    name: 'find_x',
    description: 'Find x.',
    inputSchema: { type: 'object', properties: {} },
    buildPath: () => '/v1/x',
  });
  const hand = defineReadTool({
    name: 'hand_x',
    description: 'Hand x.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => textResult('ok'),
  });
  for (const t of [list, one, tool, hand]) assert.deepEqual(t.annotations, READ, t.name);
});

test('read factories + defineReadTool: returnsSecret appends the standard SECURITY sentence once', () => {
  const s = secretSentence('the token');
  const list = readList('list_x', '/v1/x', 'List x.', { returnsSecret: 'the token' });
  const one = readOne('get_x', '/v1/x', 'Get x.', 'id', { returnsSecret: 'the token' });
  const tool = readTool({
    name: 'find_x',
    description: 'Find x.',
    inputSchema: { type: 'object', properties: {} },
    buildPath: () => '/v1/x',
    returnsSecret: 'the token',
  });
  const hand = defineReadTool(
    {
      name: 'hand_x',
      description: 'Hand x.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => textResult('ok'),
    },
    { returnsSecret: 'the token' },
  );
  for (const t of [list, one, tool, hand]) {
    assert.equal(t.description.split(s).length - 1, 1, t.name);
  }
});

// (e) confirm:true + valid args → exactly one call with the right method/path/body.
test('writeTool: confirm:true + valid args issues exactly one call with method/path/body', async () => {
  const { client, calls } = fakeWriteClient();
  const tool = writeTool({
    name: 'set_hostname',
    description: 'Set hostname.',
    method: 'POST',
    safety: { kind: 'disruptive', reason: 'renames the thing' },
    input: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
      additionalProperties: false,
    },
    buildPath: (a) => `/v1/things/${encodeSegment(a.id, 'id')}/hostname`,
    buildBody: (a) => ({ hostname: a.name }),
  });
  const result = await tool.handler(client, { id: 'a b', name: 'h', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/things/a%20b/hostname', body: { hostname: 'h' } }]);
});

// (f) zod failure → "Invalid input for", and no request.
test('writeTool: zod failure returns "Invalid input for" and makes no request', async () => {
  const { client, calls } = fakeWriteClient();
  const tool = writeTool({
    name: 'set_x',
    description: 'Set x.',
    method: 'POST',
    safety: { kind: 'plain' },
    input: z.object({ id: z.string().min(1) }).strict(),
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    buildPath: (a) => `/v1/x/${encodeSegment(a.id, 'id')}`,
  });
  const missing = await tool.handler(client, {});
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /^Error: Invalid input for set_x:/);
  const wrongType = await tool.handler(client, { id: 123 });
  assert.equal(wrongType.isError, true);
  assert.match(textOf(wrongType), /^Error: Invalid input for set_x:/);
  assert.deepEqual(calls, [], 'a zod-rejected call must not reach the client');
});

// (g) encodeSegment traversal token → rejected before any request.
test('writeTool: a ".." segment via encodeSegment is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const tool = writeTool({
    name: 'scale_service',
    description: 'Scale.',
    method: 'POST',
    safety: { kind: 'plain' },
    input: z.object({ service_id: z.string().min(1) }).strict(),
    inputSchema: {
      type: 'object',
      properties: { service_id: { type: 'string' } },
      required: ['service_id'],
      additionalProperties: false,
    },
    buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/scale`,
  });
  const result = await tool.handler(client, { service_id: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." segment');
});

// (h) method dispatch: POST/PUT/PATCH carry a body; DELETE carries none.
for (const method of ['POST', 'PUT', 'PATCH'] as const) {
  test(`writeTool: ${method} routes through client.${method.toLowerCase()} with body`, async () => {
    const { client, calls } = fakeWriteClient();
    const tool = writeTool({
      name: 'm',
      description: 'm.',
      method,
      safety: { kind: 'plain' },
      input: z.object({}).strict(),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      buildPath: () => '/v1/m',
      buildBody: () => ({ a: 1 }),
    });
    await tool.handler(client, {});
    assert.deepEqual(calls, [{ method, path: '/v1/m', body: { a: 1 } }]);
  });
}

test('writeTool: DELETE routes through client.delete with no body arg', async () => {
  const { client, calls } = fakeWriteClient();
  const tool = writeTool({
    name: 'd',
    description: 'd.',
    method: 'DELETE',
    safety: { kind: 'plain' },
    input: z.object({ id: z.string().min(1) }).strict(),
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    buildPath: (a) => `/v1/d/${encodeSegment(a.id, 'id')}`,
  });
  await tool.handler(client, { id: 'x' });
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/d/x' }]);
});

// (i) formatResult override transforms the returned data.
test('writeTool: formatResult override transforms the returned data', async () => {
  const { client } = fakeWriteClient(() => ({ kubeconfig: 'apiVersion: v1' }));
  const tool = writeTool({
    name: 'mint',
    description: 'mint.',
    method: 'POST',
    safety: { kind: 'plain' },
    input: z.object({}).strict(),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/mint',
    formatResult: (data) => textResult((data as { kubeconfig: string }).kubeconfig),
  });
  const result = await tool.handler(client, {});
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), 'apiVersion: v1');
});

// (j) APIError from the client → errorResult carrying "[CODE] message".
test('writeTool: APIError from the client maps to errorResult with [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'write scope required' });
  });
  const tool = writeTool({
    name: 'm',
    description: 'm.',
    method: 'POST',
    safety: { kind: 'plain' },
    input: z.object({}).strict(),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/m',
  });
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] write scope required');
});

// (k) writeTool's factory bound is `S extends z.ZodTypeAny`, not just
// z.ZodObject — a `.strict().refine(...)` schema is a ZodEffects, not a
// ZodObject, and must flow through unchanged: `opts.input.safeParse` works
// identically, the confirm gate and dispatch are untouched.
test('writeTool: accepts a ZodEffects (.strict().refine()) schema and dispatches on valid input', async () => {
  const { client, calls } = fakeWriteClient();
  const input = z
    .object({ productId: z.string().min(1).optional(), plan: z.string().min(1).optional() })
    .strict()
    .refine((v) => Boolean(v.productId || v.plan), { message: 'productId (or its alias plan) is required' });
  const tool = writeTool({
    name: 'deploy_thing',
    description: 'Deploy a thing.',
    method: 'POST',
    safety: { kind: 'plain' },
    input,
    inputSchema: {
      type: 'object',
      properties: { productId: { type: 'string' }, plan: { type: 'string' } },
      additionalProperties: false,
    },
    buildPath: () => '/v1/things',
    buildBody: (a) => a,
  });
  const result = await tool.handler(client, { productId: 'sku-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/things', body: { productId: 'sku-1' } }]);
});

// (l) same ZodEffects schema — a refine-violating call surfaces the zod
// error via errorResult and issues NO request.
test('writeTool: a ZodEffects refine violation returns errorResult and makes no request', async () => {
  const { client, calls } = fakeWriteClient();
  const input = z
    .object({ productId: z.string().min(1).optional(), plan: z.string().min(1).optional() })
    .strict()
    .refine((v) => Boolean(v.productId || v.plan), { message: 'productId (or its alias plan) is required' });
  const tool = writeTool({
    name: 'deploy_thing',
    description: 'Deploy a thing.',
    method: 'POST',
    safety: { kind: 'plain' },
    input,
    inputSchema: {
      type: 'object',
      properties: { productId: { type: 'string' }, plan: { type: 'string' } },
      additionalProperties: false,
    },
    buildPath: () => '/v1/things',
    buildBody: (a) => a,
  });
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for deploy_thing:/);
  assert.match(textOf(result), /productId \(or its alias plan\) is required/);
  assert.deepEqual(calls, [], 'a refine-violating call must issue no request');
});
