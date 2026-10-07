// Idempotency-Key handling in the client: header only on covered POST routes,
// one same-key retry on a transport error when the key was generated, waiting out
// IDEMPOTENCY_IN_PROGRESS, replay detection, and the RESOURCE_PROTECTED mapping.
// global.fetch is stubbed with a scripted sequence of answers; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RareCloudClient, APIError, RESOURCE_PROTECTED_GUIDANCE } from './client.js';
import type { ReplayInfo } from './idempotency.js';

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

type Step =
  | { throws: Error }
  | { status?: number; body: unknown; headers?: Record<string, string>; raw?: string };

function scriptFetch(steps: Step[]) {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body as string | undefined,
    });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ('throws' in step) throw step.throws;
    const h = new Map(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: step.status ?? 200,
      headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
      async text() {
        return step.raw ?? JSON.stringify(step.body);
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function newClient(sleeps: number[] = []) {
  return new RareCloudClient({
    endpoint: 'https://example.com',
    token: 't',
    sleep: async (ms) => { sleeps.push(ms); },
  });
}

const okBody = (data: unknown) => ({ body: { ok: true, data } });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('idempotent POST without a key: a UUIDv4 Idempotency-Key is generated and sent', async () => {
  const s = scriptFetch([okBody({ id: 'vm-1' })]);
  try {
    const data = await newClient().post('/v1/services', { productId: 'x' }, { idempotent: {} });
    assert.deepEqual(data, { id: 'vm-1' });
    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0].headers['Idempotency-Key'], UUID_V4);
  } finally {
    s.restore();
  }
});

test('two separate calls without a key get two different generated keys', async () => {
  const s = scriptFetch([okBody({})]);
  try {
    const c = newClient();
    await c.post('/v1/services', {}, { idempotent: {} });
    await c.post('/v1/services', {}, { idempotent: {} });
    assert.notEqual(s.calls[0].headers['Idempotency-Key'], s.calls[1].headers['Idempotency-Key']);
  } finally {
    s.restore();
  }
});

test('a caller-supplied key is sent verbatim', async () => {
  const s = scriptFetch([okBody({})]);
  try {
    await newClient().post('/v1/volumes', { sizeGb: 10 }, { idempotent: { key: 'my-key-1' } });
    assert.equal(s.calls[0].headers['Idempotency-Key'], 'my-key-1');
  } finally {
    s.restore();
  }
});

test('the header is never sent on a POST outside the covered list, even when asked', async () => {
  const s = scriptFetch([okBody({})]);
  try {
    await newClient().post('/v1/services/abc/hostname', { hostname: 'h' }, { idempotent: { key: 'k' } });
    await newClient().post('/v1/services/abc/hostname', { hostname: 'h' });
    assert.equal(s.calls.length, 2);
    for (const c of s.calls) assert.equal(c.headers['Idempotency-Key'], undefined);
  } finally {
    s.restore();
  }
});

test('a plain post() (no idempotent option) on a covered route sends no key', async () => {
  const s = scriptFetch([okBody({})]);
  try {
    await newClient().post('/v1/services', {});
    assert.equal(s.calls[0].headers['Idempotency-Key'], undefined);
  } finally {
    s.restore();
  }
});

test('generated key: the first answer is dropped (transport error), ONE retry with the SAME key and the same body succeeds', async () => {
  const s = scriptFetch([{ throws: new TypeError('fetch failed') }, okBody({ id: 'vm-1' })]);
  try {
    const data = await newClient().post('/v1/services', { productId: 'x' }, { idempotent: {} });
    assert.deepEqual(data, { id: 'vm-1' });
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].headers['Idempotency-Key'], s.calls[1].headers['Idempotency-Key']);
    assert.equal(s.calls[0].body, s.calls[1].body);
  } finally {
    s.restore();
  }
});

test('generated key: a timeout is a transport error and is retried once with the same key', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const s = scriptFetch([{ throws: timeout }, okBody({ id: 'vm-1' })]);
  try {
    await newClient().post('/v1/services', {}, { idempotent: {} });
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].headers['Idempotency-Key'], s.calls[1].headers['Idempotency-Key']);
  } finally {
    s.restore();
  }
});

test('generated key: a gateway 504 with a non-API body counts as a dropped answer and is retried once', async () => {
  const s = scriptFetch([{ status: 504, body: null, raw: '<html>Gateway Time-out</html>' }, okBody({ id: 'vm-1' })]);
  try {
    const data = await newClient().post('/v1/services', {}, { idempotent: {} });
    assert.deepEqual(data, { id: 'vm-1' });
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
});

test('generated key: only ONE transport retry; a second drop surfaces as NETWORK_ERROR', async () => {
  const s = scriptFetch([{ throws: new TypeError('fetch failed') }]);
  try {
    await assert.rejects(
      newClient().post('/v1/services', {}, { idempotent: {} }),
      (e: unknown) => e instanceof APIError && e.code === 'NETWORK_ERROR',
    );
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
});

test('caller-supplied key: no automatic transport retry (the agent retries with its own key)', async () => {
  const s = scriptFetch([{ throws: new TypeError('fetch failed') }, okBody({})]);
  try {
    await assert.rejects(newClient().post('/v1/services', {}, { idempotent: { key: 'k1' } }));
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});

test('a non-idempotent POST is never retried on a transport error', async () => {
  const s = scriptFetch([{ throws: new TypeError('fetch failed') }]);
  try {
    await assert.rejects(newClient().post('/v1/services/abc/hostname', {}, { idempotent: {} }));
    await assert.rejects(newClient().post('/v1/services', {}));
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
});

const inProgress = (retryAfter?: string): Step => ({
  status: 409,
  headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  body: { ok: false, error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'still being processed' } },
});

test('409 IDEMPOTENCY_IN_PROGRESS: waits Retry-After seconds and retries with the same key', async () => {
  const sleeps: number[] = [];
  const s = scriptFetch([inProgress('5'), okBody({ id: 'vm-1' })]);
  try {
    const data = await newClient(sleeps).post('/v1/services', {}, { idempotent: { key: 'k1' } });
    assert.deepEqual(data, { id: 'vm-1' });
    assert.deepEqual(sleeps, [5000]);
    assert.equal(s.calls[1].headers['Idempotency-Key'], 'k1');
  } finally {
    s.restore();
  }
});

test('409 IDEMPOTENCY_IN_PROGRESS: Retry-After is capped at 10 s and defaults when missing or junk', async () => {
  const sleeps: number[] = [];
  const s = scriptFetch([inProgress('600'), inProgress(), inProgress('soon'), okBody({})]);
  try {
    await newClient(sleeps).post('/v1/services', {}, { idempotent: {} });
    assert.deepEqual(sleeps, [10000, 5000, 5000]);
  } finally {
    s.restore();
  }
});

test('409 IDEMPOTENCY_IN_PROGRESS: bounded (3 waits), then the error surfaces', async () => {
  const sleeps: number[] = [];
  const s = scriptFetch([inProgress('1')]);
  try {
    await assert.rejects(
      newClient(sleeps).post('/v1/services', {}, { idempotent: {} }),
      (e: unknown) => e instanceof APIError && e.code === 'IDEMPOTENCY_IN_PROGRESS',
    );
    assert.equal(s.calls.length, 4);
    assert.equal(sleeps.length, 3);
  } finally {
    s.restore();
  }
});

test('transport drop, then IN_PROGRESS on the retry, then the replay: all with one key', async () => {
  const s = scriptFetch([
    { throws: new TypeError('fetch failed') },
    inProgress('5'),
    { body: { ok: true, data: { id: 'vm-1' } }, headers: { 'Idempotent-Replayed': 'true' } },
  ]);
  try {
    const replays: ReplayInfo[] = [];
    await newClient().post('/v1/services', {}, { idempotent: { onReplay: (r) => replays.push(r) } });
    assert.equal(s.calls.length, 3);
    assert.equal(new Set(s.calls.map((c) => c.headers['Idempotency-Key'])).size, 1);
    assert.equal(replays.length, 1);
  } finally {
    s.restore();
  }
});

test('422 IDEMPOTENCY_KEY_REUSED is final: no retry, error says to use a new key', async () => {
  const s = scriptFetch([
    { status: 422, body: { ok: false, error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used for a different request.' } } },
    okBody({}),
  ]);
  try {
    await assert.rejects(
      newClient().post('/v1/services', {}, { idempotent: { key: 'k1' } }),
      (e: unknown) => e instanceof APIError && e.code === 'IDEMPOTENCY_KEY_REUSED' && /new idempotency_key/.test(e.message),
    );
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});

test('any other API error is final, even with a generated key', async () => {
  const s = scriptFetch([
    { status: 400, body: { ok: false, error: { code: 'INVALID_PARAM', message: 'bad' } } },
    okBody({}),
  ]);
  try {
    await assert.rejects(newClient().post('/v1/services', {}, { idempotent: {} }));
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});

test('replay: Idempotent-Replayed: true is reported with secretsOmittedOnReplay from the envelope', async () => {
  const s = scriptFetch([
    {
      body: { ok: true, data: { id: 'vm-1' }, secretsOmittedOnReplay: ['consolePassword'] },
      headers: { 'Idempotent-Replayed': 'true' },
    },
  ]);
  try {
    const replays: ReplayInfo[] = [];
    const data = await newClient().post('/v1/services', {}, { idempotent: { key: 'k', onReplay: (r) => replays.push(r) } });
    assert.deepEqual(data, { id: 'vm-1' });
    assert.deepEqual(replays, [{ secretsOmittedOnReplay: ['consolePassword'] }]);
  } finally {
    s.restore();
  }
});

test('no replay header: onReplay is not called', async () => {
  const s = scriptFetch([okBody({ id: 'vm-1' })]);
  try {
    let called = false;
    await newClient().post('/v1/services', {}, { idempotent: { onReplay: () => { called = true; } } });
    assert.equal(called, false);
  } finally {
    s.restore();
  }
});

test('RESOURCE_PROTECTED: mapped to the never-retry guidance with the console link', async () => {
  const link = 'https://console.rarecloud.io/services/vm-1';
  const s = scriptFetch([
    {
      status: 403,
      body: {
        ok: false,
        error: {
          code: 'RESOURCE_PROTECTED',
          message: `This resource is read-only for API tokens and agents. Turn API access on for it in the console to allow this: ${link}.`,
        },
      },
    },
  ]);
  try {
    await assert.rejects(newClient().post('/v1/services/vm-1/actions/stop', {}, { idempotent: {} }), (e: unknown) => {
      assert.ok(e instanceof APIError);
      assert.equal(e.code, 'RESOURCE_PROTECTED');
      assert.ok(e.message.startsWith('[RESOURCE_PROTECTED] '), e.message);
      assert.ok(e.message.includes(RESOURCE_PROTECTED_GUIDANCE), e.message);
      assert.ok(e.message.includes(`in the console: ${link}`), e.message);
      assert.match(e.message, /Do not retry/);
      return true;
    });
    assert.equal(s.calls.length, 1, 'a protected-resource refusal is never retried');
  } finally {
    s.restore();
  }
});

test('RESOURCE_PROTECTED without a link still gives the guidance', () => {
  const e = new APIError({ code: 'RESOURCE_PROTECTED', message: 'This resource is read-only for API tokens and agents.' });
  assert.ok(e.message.includes(RESOURCE_PROTECTED_GUIDANCE));
  assert.match(e.message, /in the console\./);
});

test('other API errors keep the plain "[CODE] message" shape', () => {
  assert.equal(new APIError({ code: 'NOT_FOUND', message: 'nope' }).message, '[NOT_FOUND] nope');
});
