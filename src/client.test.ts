// Unit tests for the tiny HTTP client. We stub the global `fetch` so no
// network is touched: each test installs a fake, asserts on the captured
// request (URL, method, headers, body) and/or the parsed result, then
// restores the original fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RareCloudClient, APIError } from './client.js';

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
}

interface FakeResponse {
  status?: number;
  body: unknown;
}

// Install a fake global.fetch that records every request and replies with
// `reply` (a fixed envelope, or a function of the captured request).
function stubFetch(reply: FakeResponse | ((req: CapturedRequest) => FakeResponse)) {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(req);
    const r = typeof reply === 'function' ? reply(req) : reply;
    return {
      status: r.status ?? 200,
      async text() {
        return JSON.stringify(r.body);
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ok = (data: unknown): FakeResponse => ({ body: { ok: true, data } });

test('get() joins endpoint + path into the request URL', async () => {
  const stub = stubFetch(ok({ hello: 'world' }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const data = await client.get('/v1/volumes');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://example.com/v1/volumes');
    assert.deepEqual(data, { hello: 'world' });
  } finally {
    stub.restore();
  }
});

test('get() appends and URL-encodes query params, skipping empty ones', async () => {
  const stub = stubFetch(ok([]));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    await client.get('/v1/catalog/products', { kind: 'cloud compute', backend: undefined, category: '' });
    // undefined + '' are dropped; the space in the value is percent-encoded.
    assert.equal(stub.calls[0].url, 'https://example.com/v1/catalog/products?kind=cloud+compute');
  } finally {
    stub.restore();
  }
});

test('injects Authorization: Bearer <token> header', async () => {
  const stub = stubFetch(ok({}));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 'svc-123' });
    await client.get('/v1/account');
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer svc-123');
  } finally {
    stub.restore();
  }
});

test('throws APIError carrying the API error code + message', async () => {
  const stub = stubFetch({
    status: 404,
    body: { ok: false, error: { code: 'NOT_FOUND', message: 'volume svc-123 not found' } },
  });
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    await assert.rejects(
      () => client.get('/v1/volumes/svc-123'),
      (err: unknown) => {
        assert.ok(err instanceof APIError, 'expected an APIError');
        assert.equal(err.code, 'NOT_FOUND');
        assert.match(err.message, /volume svc-123 not found/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('put() sends PUT with a JSON body and returns the data envelope', async () => {
  const stub = stubFetch(ok({ id: 'svc-123', name: 'renamed' }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const data = await client.put('/v1/volumes/svc-123', { name: 'renamed' });
    const req = stub.calls[0];
    assert.equal(req.url, 'https://example.com/v1/volumes/svc-123');
    assert.equal(req.method, 'PUT');
    assert.equal(req.body, JSON.stringify({ name: 'renamed' }));
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.deepEqual(data, { id: 'svc-123', name: 'renamed' });
  } finally {
    stub.restore();
  }
});

test('patch() sends PATCH with a JSON body and returns the data envelope', async () => {
  const stub = stubFetch(ok({ id: 'svc-123', auto_renew: false }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const data = await client.patch('/v1/domains/svc-123', { auto_renew: false });
    const req = stub.calls[0];
    assert.equal(req.url, 'https://example.com/v1/domains/svc-123');
    assert.equal(req.method, 'PATCH');
    assert.equal(req.body, JSON.stringify({ auto_renew: false }));
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.deepEqual(data, { id: 'svc-123', auto_renew: false });
  } finally {
    stub.restore();
  }
});
