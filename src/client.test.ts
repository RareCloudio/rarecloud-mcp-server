// Unit tests for the tiny HTTP client. We stub the global `fetch` so no
// network is touched: each test installs a fake, asserts on the captured
// request (URL, method, headers, body) and/or the parsed result, then
// restores the original fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RareCloudClient, APIError } from './client.js';
import { SERVER_VERSION } from './version.js';

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

test('sets a versioned default User-Agent from SERVER_VERSION', async () => {
  const stub = stubFetch(ok({}));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    await client.get('/v1/account');
    assert.equal(stub.calls[0].headers['User-Agent'], `rarecloud-mcp/${SERVER_VERSION}`);
  } finally {
    stub.restore();
  }
});

test('honours an explicit userAgent override', async () => {
  const stub = stubFetch(ok({}));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't', userAgent: 'custom/9.9' });
    await client.get('/v1/account');
    assert.equal(stub.calls[0].headers['User-Agent'], 'custom/9.9');
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

test('client: get exposes the X-Partial-Results header through meta', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, data: [] }), {
      headers: { 'X-Partial-Results': 'cloud-vm, cloud-k8s' },
    })) as typeof fetch;
  try {
    const client = new RareCloudClient({ endpoint: 'https://x.test', token: 't' });
    const meta: { partialResults?: string[] } = {};
    await client.get('/v1/services', undefined, meta);
    assert.deepEqual(meta.partialResults, ['cloud-vm', 'cloud-k8s']);
    const none: { partialResults?: string[] } = {};
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, data: [] }))) as typeof fetch;
    await client.get('/v1/services', undefined, none);
    assert.equal(none.partialResults, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

// getText(): the plain-text endpoints (sandbox logs). A 2xx body is returned
// verbatim (never JSON-parsed); a failure still carries the JSON envelope and
// becomes the usual APIError with its HTTP status.
function stubRawFetch(status: number, text: string) {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string> });
    return { status, headers: new Headers(), async text() { return text; } } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('getText() GETs with the bearer token and returns a 2xx body verbatim', async () => {
  const stub = stubRawFetch(200, '{"looks":"like json"}\nline 2\n');
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 'svc-1' });
    const text = await client.getText('/v1/sandboxes/sbx-1/logs?tail=5');
    assert.equal(text, '{"looks":"like json"}\nline 2\n');
    assert.equal(stub.calls[0].url, 'https://example.com/v1/sandboxes/sbx-1/logs?tail=5');
    assert.equal(stub.calls[0].method, 'GET');
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer svc-1');
  } finally {
    stub.restore();
  }
});

test('getText() returns an empty 200 body as an empty string', async () => {
  const stub = stubRawFetch(200, '');
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    assert.equal(await client.getText('/v1/sandboxes/sbx-1/logs'), '');
  } finally {
    stub.restore();
  }
});

test('getText() turns an error envelope into an APIError with code, message and status', async () => {
  const stub = stubRawFetch(503, JSON.stringify({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'Logs are not available yet.' } }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    await assert.rejects(client.getText('/v1/sandboxes/sbx-1/logs'), (e: unknown) => {
      assert.ok(e instanceof APIError);
      assert.equal(e.code, 'BACKEND_UNAVAILABLE');
      assert.equal(e.status, 503);
      assert.equal(e.message, '[BACKEND_UNAVAILABLE] Logs are not available yet.');
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('getText() maps a non-JSON error page to INVALID_RESPONSE with the status', async () => {
  const stub = stubRawFetch(502, '<html>bad gateway</html>');
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    await assert.rejects(client.getText('/v1/x'), (e: unknown) => {
      assert.ok(e instanceof APIError);
      assert.equal(e.code, 'INVALID_RESPONSE');
      assert.equal(e.status, 502);
      return true;
    });
  } finally {
    stub.restore();
  }
});
