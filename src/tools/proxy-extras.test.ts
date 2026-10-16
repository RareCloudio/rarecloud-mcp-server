// Unit tests for the proxy extras: bandwidth usage, the live proxy check, the
// replacement locations, and the mobile auto-rotation read/write + rotate. A
// fake client records method + path + body (no network); we assert the exact
// request each tool makes, closed schemas, read vs write annotations, the
// confirm gate (refusal with NO request), the intervalMinutes bounds on both
// layers, traversal guards and the APIError -> errorResult mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProxyBandwidth,
  checkProxy,
  listProxyReplacementLocations,
  getProxyAutoRotation,
} from './proxies.js';
import { setProxyAutoRotation, rotateProxy } from './proxies-write.js';
import { APIError, type RareCloudClient, type PostOptions } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

type Call = { method: string; path: string; body?: unknown; idempotent: boolean };

function fakeClient(impl: (m: string, p: string) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const rec = (method: string) => async (path: string, body?: unknown, opts?: PostOptions) => {
    calls.push({ method, path, body, idempotent: Boolean(opts?.idempotent) });
    return impl(method, path);
  };
  const client = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path, idempotent: false });
      return impl('GET', path);
    },
    post: rec('POST'),
    put: rec('PUT'),
    patch: rec('PATCH'),
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path, idempotent: false });
      return impl('DELETE', path);
    },
  } as unknown as RareCloudClient;
  return { client, calls };
}

function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

const PX = '5f0c7e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const READ_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---------------------------------------------------------------------------
// Reads: name, read annotations, closed schema requiring id, exact request.
// ---------------------------------------------------------------------------

const READS: Array<[ToolDefinition, string, string, string]> = [
  [getProxyBandwidth, 'get_proxy_bandwidth', 'GET', `/v1/proxies/${PX}/bandwidth`],
  [checkProxy, 'check_proxy', 'POST', `/v1/proxies/${PX}/check`],
  [listProxyReplacementLocations, 'list_proxy_replacement_locations', 'GET', `/v1/proxies/${PX}/replacements/locations`],
  [getProxyAutoRotation, 'get_proxy_auto_rotation', 'GET', `/v1/proxies/${PX}/auto-rotation`],
];

for (const [tool, name, method, path] of READS) {
  test(`proxy extras: ${name} is a read that sends ${method} ${path}`, async () => {
    assert.equal(tool.name, name);
    assert.deepEqual(tool.annotations, READ_ANN);
    assert.deepEqual(tool.inputSchema.required, ['id']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
    assert.ok(!tool.description.includes('Safety:'));
    const { client, calls } = fakeClient(() => ({ value: 1 }));
    const result = await tool.handler(client, { id: PX });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, method);
    assert.equal(calls[0].path, path);
    assert.equal(calls[0].idempotent, false);
    assert.deepEqual(JSON.parse(textOf(result)), { value: 1 });
  });

  test(`proxy extras: ${name} rejects a traversal id with no request`, async () => {
    for (const id of ['..', '.', '']) {
      const { client, calls } = fakeClient();
      const result = await tool.handler(client, { id });
      assert.equal(result.isError, true);
      assert.deepEqual(calls, []);
    }
  });

  test(`proxy extras: ${name} maps an APIError to an errorResult`, async () => {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'INVALID_PARAM', message: 'wrong proxy kind' });
    });
    const result = await tool.handler(client, { id: PX });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: [INVALID_PARAM] wrong proxy kind');
  });
}

test('check_proxy: sends no body (the route takes none)', async () => {
  const { client, calls } = fakeClient(() => ({ results: [] }));
  await checkProxy.handler(client, { id: PX });
  assert.equal(calls[0].body, undefined);
});

test('check_proxy: description says plainly it sends traffic through the proxy and refreshes the shown location', () => {
  assert.match(checkProxy.description, /sends a small amount of traffic through each proxy/);
  assert.match(checkProxy.description, /refreshes the location the API shows/);
});

test('check_proxy: rejects unknown input with no request', async () => {
  const { client, calls } = fakeClient();
  const result = await checkProxy.handler(client, { id: PX, extra: 1 });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Writes: set_proxy_auto_rotation (PUT) and rotate_proxy (POST), both disruptive.
// ---------------------------------------------------------------------------

const WRITE_ANN = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

test('set_proxy_auto_rotation: closed schema with the 5-1440 bounds, confirm required, services:write, DISRUPTIVE', () => {
  const t = setProxyAutoRotation;
  assert.equal(t.name, 'set_proxy_auto_rotation');
  assert.deepEqual(t.annotations, WRITE_ANN);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.deepEqual([...(t.inputSchema.required ?? [])].sort(), ['confirm', 'enabled', 'id', 'intervalMinutes']);
  assert.deepEqual(t.inputSchema.properties.intervalMinutes, {
    type: 'integer',
    minimum: 5,
    maximum: 1440,
    description: (t.inputSchema.properties.intervalMinutes as { description: string }).description,
  });
  assert.ok(!('idempotency_key' in t.inputSchema.properties));
  assert.match(t.description, /services:write/);
  assert.match(t.description, /Safety: DISRUPTIVE;/);
});

test('set_proxy_auto_rotation: PUTs {enabled, intervalMinutes} to /v1/proxies/{id}/auto-rotation when confirmed', async () => {
  const { client, calls } = fakeClient(() => ({ enabled: true, intervalMinutes: 30 }));
  const result = await setProxyAutoRotation.handler(client, { id: PX, enabled: true, intervalMinutes: 30, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PUT', path: `/v1/proxies/${PX}/auto-rotation`, body: { enabled: true, intervalMinutes: 30 }, idempotent: false },
  ]);
});

test('set_proxy_auto_rotation: refuses with NO request without confirm:true', async () => {
  for (const confirm of [undefined, false]) {
    const { client, calls } = fakeClient();
    const args: Record<string, unknown> = { id: PX, enabled: false, intervalMinutes: 60 };
    if (confirm !== undefined) args.confirm = confirm;
    const result = await setProxyAutoRotation.handler(client, args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error: set_proxy_auto_rotation was NOT executed because it is disruptive/);
    assert.deepEqual(calls, []);
  }
});

test('set_proxy_auto_rotation: rejects intervalMinutes outside 5-1440, a non-integer, or a missing field, with no request', async () => {
  for (const bad of [
    { intervalMinutes: 4, enabled: true },
    { intervalMinutes: 1441, enabled: true },
    { intervalMinutes: 7.5, enabled: true },
    { enabled: true },
    { intervalMinutes: 30 },
  ]) {
    const { client, calls } = fakeClient();
    const result = await setProxyAutoRotation.handler(client, { id: PX, ...bad, confirm: true });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.deepEqual(calls, []);
  }
});

test('set_proxy_auto_rotation: accepts the bounds 5 and 1440', async () => {
  for (const intervalMinutes of [5, 1440]) {
    const { client, calls } = fakeClient();
    await setProxyAutoRotation.handler(client, { id: PX, enabled: true, intervalMinutes, confirm: true });
    assert.equal(calls.length, 1);
  }
});

test('rotate_proxy: closed schema, confirm required, no idempotency_key, services:write, DISRUPTIVE', () => {
  const t = rotateProxy;
  assert.equal(t.name, 'rotate_proxy');
  assert.deepEqual(t.annotations, WRITE_ANN);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.deepEqual([...(t.inputSchema.required ?? [])].sort(), ['confirm', 'id']);
  assert.ok(!('idempotency_key' in t.inputSchema.properties));
  assert.match(t.description, /services:write/);
  assert.match(t.description, /Safety: DISRUPTIVE;/);
});

test('rotate_proxy: POSTs to /v1/proxies/{id}/rotate with no body and no Idempotency-Key when confirmed', async () => {
  const { client, calls } = fakeClient(() => ({ rotated: true }));
  const result = await rotateProxy.handler(client, { id: PX, confirm: true });
  assert.deepEqual(JSON.parse(textOf(result)), { rotated: true });
  assert.deepEqual(calls, [{ method: 'POST', path: `/v1/proxies/${PX}/rotate`, body: undefined, idempotent: false }]);
});

test('rotate_proxy: refuses with NO request without confirm:true', async () => {
  const { client, calls } = fakeClient();
  const result = await rotateProxy.handler(client, { id: PX });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: rotate_proxy was NOT executed because it is disruptive/);
  assert.deepEqual(calls, []);
});

test('proxy extras writes: a traversal id is rejected before any request', async () => {
  for (const [tool, extra] of [
    [setProxyAutoRotation, { enabled: true, intervalMinutes: 30 }],
    [rotateProxy, {}],
  ] as Array<[ToolDefinition, Record<string, unknown>]>) {
    const { client, calls } = fakeClient();
    const result = await tool.handler(client, { id: '..', ...extra, confirm: true });
    assert.equal(result.isError, true, tool.name);
    assert.deepEqual(calls, []);
  }
});

test('proxy extras writes: an APIError maps to an errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'INVALID_PARAM', message: 'mobile only' });
  });
  const result = await rotateProxy.handler(client, { id: PX, confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [INVALID_PARAM] mobile only');
});
