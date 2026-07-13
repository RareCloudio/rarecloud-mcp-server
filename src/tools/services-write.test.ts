// Unit tests for the first Parity Phase B write tool, set_service_hostname.
// A fake client records method+path+body (no network); we assert the closed
// schema, path encoding, body shape, the traversal guard, zod rejection, and
// the uniform APIError -> errorResult mapping the factory provides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setServiceHostname } from './services-write.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

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

function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

test('set_service_hostname: name + closed schema (no confirm — plain write)', () => {
  assert.equal(setServiceHostname.name, 'set_service_hostname');
  assert.ok(setServiceHostname.description.trim().length > 0);
  assert.deepEqual(setServiceHostname.inputSchema.required, ['service_id', 'hostname']);
  assert.equal(setServiceHostname.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(setServiceHostname.inputSchema.properties), ['service_id', 'hostname']);
  // A non-gated write must NOT advertise confirm, and carries no destructiveHint.
  assert.ok(!('confirm' in setServiceHostname.inputSchema.properties));
  assert.equal(setServiceHostname.annotations, undefined);
});

test('set_service_hostname: encodes service_id into the path and POSTs the hostname body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServiceHostname.handler(client, { service_id: 'svc 1/2', hostname: 'h' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/svc%201%2F2/hostname', body: { hostname: 'h' } },
  ]);
});

test('set_service_hostname: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServiceHostname.handler(client, { service_id: '..', hostname: 'h' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." service_id');
});

test('set_service_hostname: missing hostname is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServiceHostname.handler(client, { service_id: 'srv-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_service_hostname:/);
  assert.deepEqual(calls, [], 'a zod-rejected call must not reach the client');
});

test('set_service_hostname: APIError maps to errorResult with [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await setServiceHostname.handler(client, { service_id: 'srv-1', hostname: 'h' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});
