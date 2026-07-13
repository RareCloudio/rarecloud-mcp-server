// Unit tests for the residential-proxy read tools (Task 6). A new domain module
// covering the legacy residential-proxy product: the service list/detail, the
// live proxy list (credentials), auth settings, GB Residential metadata
// (countries, rotation intervals), the proxy-requests list + their per-request
// proxy lists, and the replacement allowance. A fake client records the
// constructed path and returns a canned payload — no network.
//
// Two tools return LIVE credentials (get_proxy_list, get_proxy_request_list);
// their descriptions must carry the same secret-handling guidance as the
// kubeconfig tools, guarded by explicit description tests below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listProxies,
  getProxyCatalog,
  getProxy,
  getProxyList,
  getProxyAuth,
  listGbResidentialCountries,
  listGbRotationIntervals,
  listProxyRequests,
  getProxyRequestList,
  getProxyReplacements,
} from './proxies.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

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

function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

// --- fixed reads, no input -------------------------------------------------
// [tool, name, path]
const fixed: Array<[ToolDefinition, string, string]> = [
  [listProxies, 'list_proxies', '/v1/proxies'],
  [getProxyCatalog, 'get_proxy_catalog', '/v1/proxies/catalog'],
  [listGbResidentialCountries, 'list_gb_residential_countries', '/v1/proxies/residential/countries'],
  [listGbRotationIntervals, 'list_gb_rotation_intervals', '/v1/proxies/residential/rotation-intervals'],
];

for (const [tool, name, path] of fixed) {
  test(`proxies: ${name} — name, GETs ${path}, empty closed schema`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    const { client, calls } = fakeClient(() => [{ id: 'px-1' }]);
    const result = await tool.handler(client, {});
    assert.deepEqual(calls, [path]);
    assert.deepEqual(JSON.parse(textOf(result)), [{ id: 'px-1' }]);
  });

  test(`proxies: ${name} — APIError maps to errorResult`, async () => {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'FORBIDDEN', message: 'proxies:read required' });
    });
    const result = await tool.handler(client, {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: [FORBIDDEN] proxies:read required');
  });
}

// --- single-id detail read (get_proxy, readOne) ----------------------------

test('proxies: get_proxy — encodes id into /v1/proxies/{id}, closed schema requires id', async () => {
  assert.equal(getProxy.name, 'get_proxy');
  assert.deepEqual(getProxy.inputSchema.required, ['id']);
  assert.equal(getProxy.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(getProxy.inputSchema.properties), ['id']);
  const { client, calls } = fakeClient(() => ({ id: 'a b/c' }));
  await getProxy.handler(client, { id: 'a b/c' });
  assert.deepEqual(calls, ['/v1/proxies/a%20b%2Fc']);
});

test('proxies: get_proxy — returns the payload as JSON text', async () => {
  const { client } = fakeClient(() => ({ id: 'px-1', flavor: 'isp' }));
  const result = await getProxy.handler(client, { id: 'px-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { id: 'px-1', flavor: 'isp' });
});

// --- per-id sub-path reads (proxy-list / auth / proxy-requests / replacements)
// [tool, name, suffix] — path is /v1/proxies/{id}{suffix}, JSON out.
const idScoped: Array<[ToolDefinition, string, string]> = [
  [getProxyList, 'get_proxy_list', '/proxy-list'],
  [getProxyAuth, 'get_proxy_auth', '/auth'],
  [listProxyRequests, 'list_proxy_requests', '/proxy-requests'],
  [getProxyReplacements, 'get_proxy_replacements', '/replacements'],
];

for (const [tool, name, suffix] of idScoped) {
  test(`proxies: ${name} — encodes id into /v1/proxies/{id}${suffix}`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    const { client, calls } = fakeClient(() => ({ ok: true }));
    await tool.handler(client, { id: 'px 1/2' });
    assert.deepEqual(calls, [`/v1/proxies/px%201%2F2${suffix}`]);
  });

  test(`proxies: ${name} — requires id (closed schema, only id)`, () => {
    assert.deepEqual(tool.inputSchema.required, ['id']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
  });

  test(`proxies: ${name} — returns the payload as JSON text`, async () => {
    const { client } = fakeClient(() => ({ items: [{ ip: '203.0.113.10', port: 8080 }] }));
    const result = await tool.handler(client, { id: 'px-123' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(result)), { items: [{ ip: '203.0.113.10', port: 8080 }] });
  });

  test(`proxies: ${name} — APIError maps to errorResult`, async () => {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'NOT_FOUND', message: 'no such proxy' });
    });
    const result = await tool.handler(client, { id: 'px-123' });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: [NOT_FOUND] no such proxy');
  });
}

// --- two-param path (get_proxy_request_list) -------------------------------
// /v1/proxies/{id}/proxy-requests/{reqId}/proxy-list — inputs named id + request_id.

test('proxies: get_proxy_request_list — requires id + request_id (closed schema)', () => {
  assert.equal(getProxyRequestList.name, 'get_proxy_request_list');
  assert.deepEqual(getProxyRequestList.inputSchema.required, ['id', 'request_id']);
  assert.equal(getProxyRequestList.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(getProxyRequestList.inputSchema.properties), ['id', 'request_id']);
});

test('proxies: get_proxy_request_list — encodes both ids into the two-param path', async () => {
  const { client, calls } = fakeClient(() => ({ ok: true }));
  await getProxyRequestList.handler(client, { id: 'px 1/2', request_id: 'req a/b' });
  assert.deepEqual(calls, ['/v1/proxies/px%201%2F2/proxy-requests/req%20a%2Fb/proxy-list']);
});

test('proxies: get_proxy_request_list — returns the payload as JSON text', async () => {
  const { client } = fakeClient(() => ({ items: [{ ip: '198.51.100.7', port: 3128 }] }));
  const result = await getProxyRequestList.handler(client, { id: 'px-1', request_id: 'req-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { items: [{ ip: '198.51.100.7', port: 3128 }] });
});

test('proxies: get_proxy_request_list — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'no such proxy-request' });
  });
  const result = await getProxyRequestList.handler(client, { id: 'px-1', request_id: 'req-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [NOT_FOUND] no such proxy-request');
});

// --- secret-handling guard (the three credential tools) --------------------
// get_proxy_list and get_proxy_request_list return live proxy credentials
// (ip/port/username/password); get_proxy_auth returns the proxy credentials
// too (null when the service is IP-only). Their descriptions must carry the
// same treat-as-secret guidance as the kubeconfig tools: don't echo the result
// back unless the user explicitly asks.
for (const [tool, name] of [
  [getProxyList, 'get_proxy_list'],
  [getProxyRequestList, 'get_proxy_request_list'],
  [getProxyAuth, 'get_proxy_auth'],
] as Array<[ToolDefinition, string]>) {
  test(`proxies: ${name} — description carries the secret-handling warning`, () => {
    assert.match(tool.description, /secret/i);
    assert.match(tool.description, /credential/i);
    assert.match(tool.description, /do NOT echo/);
    assert.match(tool.description, /unless the user explicitly asks/i);
  });
}

// The non-credential reads must NOT carry the secret warning — keeps the guard
// meaningful and stops the warning from leaking onto metadata reads.
test('proxies: metadata reads do not carry the secret warning', () => {
  for (const tool of [listProxies, getProxy, listProxyRequests, getProxyReplacements]) {
    assert.doesNotMatch(tool.description, /do NOT echo/);
  }
});
