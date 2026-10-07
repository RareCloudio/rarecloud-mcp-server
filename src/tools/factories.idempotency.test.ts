// writeTool + Idempotency-Key, end to end through the real client with a
// stubbed fetch: the advertised input, validation, the confirm gate running
// first, the dropped-first-answer retry, and how a replay reads to the agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { writeTool, IDEMPOTENCY_KEY_PROPERTY } from './factories.js';
import { RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

type Step = { throws: Error } | { status?: number; body: unknown; headers?: Record<string, string> };

function scriptFetch(steps: Step[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: init?.body as string });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ('throws' in step) throw step.throws;
    const h = new Map(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: step.status ?? 200,
      headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
      async text() { return JSON.stringify(step.body); },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const client = () => new RareCloudClient({ endpoint: 'https://example.com', token: 't', sleep: async () => {} });
const texts = (r: ToolCallResult) => r.content.map((b) => (b.type === 'text' ? b.text : ''));

const gatedCreate = writeTool({
  name: 'create_thing',
  description: 'Create a thing. Requires scope services:write.',
  method: 'POST',
  safety: { kind: 'spends', reason: 'creates a billable thing' },
  idempotent: true,
  input: z.object({ name: z.string().min(1) }).strict(),
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  buildPath: () => '/v1/volumes',
  buildBody: (a) => a,
});

const plainNonIdempotent = writeTool({
  name: 'rename_thing',
  description: 'Rename a thing. Requires scope services:write.',
  method: 'POST',
  safety: { kind: 'plain' },
  input: z.object({ name: z.string().min(1) }).strict(),
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  buildPath: () => '/v1/services/abc/hostname',
  buildBody: (a) => a,
});

test('idempotent writeTool advertises an optional idempotency_key with the retry wording; others do not', () => {
  const p = gatedCreate.inputSchema.properties.idempotency_key as { type: string; minLength: number; maxLength: number; pattern: string; description: string };
  assert.deepEqual(p, IDEMPOTENCY_KEY_PROPERTY);
  assert.equal(p.type, 'string');
  assert.equal(p.minLength, 1);
  assert.equal(p.maxLength, 255);
  assert.match(p.description, /reuse the same value if you retry this exact request/);
  assert.ok(!gatedCreate.inputSchema.required?.includes('idempotency_key'));
  assert.ok(!('idempotency_key' in plainNonIdempotent.inputSchema.properties));
});

test('idempotent writeTool on a non-POST method is a definition error', () => {
  assert.throws(() =>
    writeTool({
      name: 'bad', description: 'x', method: 'PUT', safety: { kind: 'plain' }, idempotent: true,
      input: z.object({}).strict(), inputSchema: { type: 'object', properties: {} }, buildPath: () => '/v1/volumes',
    }),
  );
});

test('confirm gate runs first: no key, no request without confirm:true', async () => {
  const s = scriptFetch([{ body: { ok: true, data: {} } }]);
  try {
    const r = await gatedCreate.handler(client(), { name: 'a', idempotency_key: 'k1' });
    assert.equal(r.isError, true);
    assert.match(texts(r)[0], /was NOT executed/);
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test('an invalid idempotency_key is refused before any request', async () => {
  const s = scriptFetch([{ body: { ok: true, data: {} } }]);
  try {
    for (const bad of ['', 'x'.repeat(256), 'café', 7]) {
      const r = await gatedCreate.handler(client(), { name: 'a', idempotency_key: bad, confirm: true });
      assert.equal(r.isError, true);
      assert.match(texts(r)[0], /idempotency_key must be 1 to 255 printable ASCII characters/);
    }
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test('the key is sent as the Idempotency-Key header and never reaches the body', async () => {
  const s = scriptFetch([{ body: { ok: true, data: { id: 'v1' } } }]);
  try {
    const r = await gatedCreate.handler(client(), { name: 'a', idempotency_key: 'k1', confirm: true });
    assert.equal(r.isError, undefined);
    assert.equal(s.calls[0].headers['Idempotency-Key'], 'k1');
    assert.deepEqual(JSON.parse(s.calls[0].body!), { name: 'a' });
  } finally {
    s.restore();
  }
});

test('mock drops the first answer: the tool retries once with the same generated key and returns the result', async () => {
  const s = scriptFetch([{ throws: new TypeError('fetch failed') }, { body: { ok: true, data: { id: 'v1' } } }]);
  try {
    const r = await gatedCreate.handler(client(), { name: 'a', confirm: true });
    assert.equal(r.isError, undefined);
    assert.equal(s.calls.length, 2);
    assert.ok(s.calls[0].headers['Idempotency-Key']);
    assert.equal(s.calls[0].headers['Idempotency-Key'], s.calls[1].headers['Idempotency-Key']);
    assert.deepEqual(JSON.parse(texts(r).at(-1)!), { id: 'v1' });
  } finally {
    s.restore();
  }
});

test('a replay says so and passes on secretsOmittedOnReplay', async () => {
  const s = scriptFetch([
    {
      body: { ok: true, data: { id: 'vm-1' }, secretsOmittedOnReplay: ['consolePassword'] },
      headers: { 'Idempotent-Replayed': 'true' },
    },
  ]);
  try {
    const r = await gatedCreate.handler(client(), { name: 'a', idempotency_key: 'k1', confirm: true });
    const [note, json] = texts(r);
    assert.match(note, /replay/i);
    assert.match(note, /ran once/);
    assert.match(note, /secretsOmittedOnReplay: \["consolePassword"\]/);
    assert.match(note, /shown only in the first answer/);
    assert.deepEqual(JSON.parse(json), { id: 'vm-1' });
  } finally {
    s.restore();
  }
});

test('a replay with no omitted secrets says it is a replay and nothing about secrets', async () => {
  const s = scriptFetch([{ body: { ok: true, data: { id: 'n1' } }, headers: { 'Idempotent-Replayed': 'true' } }]);
  try {
    const r = await gatedCreate.handler(client(), { name: 'a', confirm: true });
    const [note] = texts(r);
    assert.match(note, /replay/i);
    assert.doesNotMatch(note, /secretsOmittedOnReplay/);
  } finally {
    s.restore();
  }
});

test('a fresh (not replayed) answer has no replay note', async () => {
  const s = scriptFetch([{ body: { ok: true, data: { id: 'n1' } } }]);
  try {
    const r = await gatedCreate.handler(client(), { name: 'a', confirm: true });
    assert.equal(r.content.length, 1);
  } finally {
    s.restore();
  }
});

test('a non-idempotent tool rejects idempotency_key as an unknown input and never sends the header', async () => {
  const s = scriptFetch([{ body: { ok: true, data: {} } }]);
  try {
    const r = await plainNonIdempotent.handler(client(), { name: 'a', idempotency_key: 'k' });
    assert.equal(r.isError, true);
    assert.equal(s.calls.length, 0);
    await plainNonIdempotent.handler(client(), { name: 'a' });
    assert.equal(s.calls[0].headers['Idempotency-Key'], undefined);
  } finally {
    s.restore();
  }
});

test('RESOURCE_PROTECTED reaches the agent as the never-retry guidance', async () => {
  const s = scriptFetch([
    {
      status: 403,
      body: { ok: false, error: { code: 'RESOURCE_PROTECTED', message: 'This resource is read-only for API tokens and agents. Turn API access on for it in the console to allow this: https://console.rarecloud.io/services/x' } },
    },
  ]);
  try {
    const r = await gatedCreate.handler(client(), { name: 'a', confirm: true });
    assert.equal(r.isError, true);
    assert.match(texts(r)[0], /read-only for agents/);
    assert.match(texts(r)[0], /Do not retry/);
    assert.match(texts(r)[0], /https:\/\/console\.rarecloud\.io\/services\/x$/);
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});
