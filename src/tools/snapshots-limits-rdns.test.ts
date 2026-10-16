// Unit tests for the VM snapshot, cloud quota and reverse DNS tools. A fake
// client records method + path + body (no network); we assert the exact
// request each tool makes, closed schemas, the confirm gate (refusal with NO
// request), destructiveHint, idempotency_key offering, traversal guards and the
// APIError -> errorResult mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSnapshots, listServiceSnapshots, getSnapshot } from './snapshots.js';
import { createSnapshot, deleteSnapshot, restoreSnapshot } from './snapshots-write.js';
import { getQuotaLimits, estimateLimits, listQuotaRequests } from './limits.js';
import { requestQuotaIncrease } from './limits-write.js';
import { getServiceRdns } from './rdns.js';
import { setServiceRdns, deleteServiceRdns } from './rdns-write.js';
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

const VM = '7d3c1a2b-1111-4222-8333-944455556666';
const SNAP = '0b6f1c2e-6d1a-4f43-9c3e-2a7d9e8f1b20';

// ---------------------------------------------------------------------------
// Reads: name, read annotations, closed schema, exact GET path.
// ---------------------------------------------------------------------------

const READS: Array<[ToolDefinition, string, Record<string, unknown>, string]> = [
  [listSnapshots, 'list_snapshots', {}, '/v1/snapshots'],
  [listServiceSnapshots, 'list_service_snapshots', { service_id: VM }, `/v1/services/${VM}/snapshots`],
  [getSnapshot, 'get_snapshot', { id: SNAP }, `/v1/snapshots/${SNAP}`],
  [getQuotaLimits, 'get_quota_limits', {}, '/v1/limits'],
  [listQuotaRequests, 'list_quota_requests', {}, '/v1/limits/requests'],
  [getServiceRdns, 'get_service_rdns', { service_id: VM }, `/v1/services/${VM}/rdns`],
];

test('reads: each GETs its exact path, is read-only, closed schema, JSON out', async () => {
  for (const [tool, name, args, path] of READS) {
    assert.equal(tool.name, name);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} readOnlyHint`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} closed schema`);
    assert.ok(!tool.description.includes('Safety:'), `${name} is a read`);
    const { client, calls } = fakeClient(() => ({ items: [1] }));
    const result = await tool.handler(client, args);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`GET ${path}`], name);
    assert.deepEqual(JSON.parse(textOf(result)), { items: [1] });
  }
});

test('reads: id segments are encoded and traversal tokens make no request', async () => {
  for (const [tool, key, prefix, suffix] of [
    [listServiceSnapshots, 'service_id', '/v1/services/', '/snapshots'],
    [getSnapshot, 'id', '/v1/snapshots/', ''],
    [getServiceRdns, 'service_id', '/v1/services/', '/rdns'],
  ] as const) {
    const { client, calls } = fakeClient();
    await tool.handler(client, { [key]: 'a/b' });
    assert.equal(calls[0].path, `${prefix}a%2Fb${suffix}`, tool.name);
    for (const bad of ['..', '.', '']) {
      const r = fakeClient();
      const result = await tool.handler(r.client, { [key]: bad });
      assert.equal(result.isError, true, `${tool.name} ${JSON.stringify(bad)}`);
      assert.deepEqual(r.calls, [], `${tool.name} must make no request for ${JSON.stringify(bad)}`);
    }
  }
});

test('reads: APIError maps to an error result', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'Cloud VM not found.' }, { status: 404 });
  });
  const result = await listServiceSnapshots.handler(client, { service_id: 'vps-123' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Cloud VM not found/);
});

// ---------------------------------------------------------------------------
// estimate_limits: a read-only POST (no gate, no idempotency_key).
// ---------------------------------------------------------------------------

test('estimate_limits: read tool that POSTs the pools to /v1/limits/estimate', async () => {
  assert.equal(estimateLimits.annotations.readOnlyHint, true);
  assert.ok(!('confirm' in estimateLimits.inputSchema.properties));
  assert.ok(!('idempotency_key' in estimateLimits.inputSchema.properties));
  const pools = [{ machineType: 'g-8vcpu-32gb', minimum: 1, maximum: 3 }];
  const { client, calls } = fakeClient(() => ({ available: true }));
  const result = await estimateLimits.handler(client, { pools });
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/limits/estimate', body: { pools }, idempotent: false }]);
  assert.deepEqual(JSON.parse(textOf(result)), { available: true });
});

test('estimate_limits: invalid pools are refused before any request', async () => {
  for (const args of [
    { pools: [] },
    { pools: [{ machineType: 'm', minimum: 3, maximum: 2 }] },
    { pools: [{ machineType: 'm', minimum: 1, maximum: 17 }] },
    { pools: Array.from({ length: 6 }, () => ({ machineType: 'm', minimum: 1, maximum: 1 })) },
    { pools: [{ machineType: 'm', minimum: 1, maximum: 1, extra: 1 }] },
    { pools: [{ machineType: 'm', minimum: 1, maximum: 1 }], extra: true },
  ]) {
    const { client, calls } = fakeClient();
    const result = await estimateLimits.handler(client, args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), /Invalid input for estimate_limits/);
    assert.deepEqual(calls, []);
  }
});

// ---------------------------------------------------------------------------
// Writes: method, path, body, gate, destructiveHint, idempotency_key.
// ---------------------------------------------------------------------------

type WriteCase = {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  method: string;
  path: string;
  body: unknown;
  gated: boolean;
  destructiveHint: boolean;
  idempotent: boolean;
};

const WRITES: Record<string, WriteCase> = {
  create_snapshot: {
    tool: createSnapshot, args: { service_id: VM, name: 'before-upgrade' },
    method: 'POST', path: `/v1/services/${VM}/snapshots`, body: { name: 'before-upgrade' },
    gated: true, destructiveHint: false, idempotent: true,
  },
  delete_snapshot: {
    tool: deleteSnapshot, args: { id: SNAP },
    method: 'DELETE', path: `/v1/snapshots/${SNAP}`, body: undefined,
    gated: true, destructiveHint: true, idempotent: false,
  },
  restore_snapshot: {
    tool: restoreSnapshot, args: { service_id: VM, snapshotId: SNAP },
    method: 'POST', path: `/v1/services/${VM}/restore`, body: { snapshotId: SNAP },
    gated: true, destructiveHint: true, idempotent: false,
  },
  request_quota_increase: {
    tool: requestQuotaIncrease,
    args: { requested: { cores: 32, sandboxes: 20 }, reason: 'scaling the prod cluster', context: { kind: 'k8s', name: 'prod' } },
    method: 'POST', path: '/v1/limits/requests',
    body: { requested: { cores: 32, sandboxes: 20 }, reason: 'scaling the prod cluster', context: { kind: 'k8s', name: 'prod' } },
    gated: true, destructiveHint: false, idempotent: true,
  },
  set_service_rdns: {
    tool: setServiceRdns, args: { service_id: VM, hostname: 'mail.example.com' },
    method: 'PUT', path: `/v1/services/${VM}/rdns`, body: { hostname: 'mail.example.com' },
    gated: true, destructiveHint: true, idempotent: false,
  },
  delete_service_rdns: {
    tool: deleteServiceRdns, args: { service_id: VM },
    method: 'DELETE', path: `/v1/services/${VM}/rdns`, body: undefined,
    gated: true, destructiveHint: true, idempotent: false,
  },
};

test('writes: name, scope literal, closed schema, gate and annotations', () => {
  for (const [name, c] of Object.entries(WRITES)) {
    assert.equal(c.tool.name, name);
    assert.match(c.tool.description, /services:write/, `${name} names its scope`);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} closed schema`);
    assert.equal('confirm' in c.tool.inputSchema.properties, c.gated, `${name} confirm`);
    assert.equal(c.tool.annotations.readOnlyHint, false, `${name} readOnlyHint`);
    assert.equal(c.tool.annotations.destructiveHint, c.destructiveHint, `${name} destructiveHint`);
    assert.equal('idempotency_key' in c.tool.inputSchema.properties, c.idempotent, `${name} idempotency_key`);
  }
});

test('writes: without confirm each refuses and makes NO request', async () => {
  for (const [name, c] of Object.entries(WRITES)) {
    for (const confirm of [undefined, false]) {
      const { client, calls } = fakeClient();
      const result = await c.tool.handler(client, confirm === undefined ? { ...c.args } : { ...c.args, confirm });
      assert.equal(result.isError, true, `${name} must refuse`);
      assert.match(textOf(result), new RegExp(`^Error: ${name} was NOT executed because it `));
      assert.deepEqual(calls, [], `${name} made a request without confirm`);
    }
  }
});

test('writes: with confirm:true each makes exactly the expected request', async () => {
  for (const [name, c] of Object.entries(WRITES)) {
    const { client, calls } = fakeClient(() => ({ ok: true }));
    const result = await c.tool.handler(client, { ...c.args, confirm: true });
    assert.equal(result.isError, undefined, `${name}: ${textOf(result)}`);
    assert.equal(calls.length, 1, name);
    assert.equal(calls[0].method, c.method, `${name} method`);
    assert.equal(calls[0].path, c.path, `${name} path`);
    assert.deepEqual(calls[0].body, c.body, `${name} body`);
    assert.equal(calls[0].idempotent, c.idempotent, `${name} idempotent dispatch`);
  }
});

test('writes: traversal tokens in path segments make no request', async () => {
  for (const [name, c] of Object.entries(WRITES)) {
    const key = 'service_id' in c.args ? 'service_id' : 'id' in c.args ? 'id' : null;
    if (!key) continue;
    for (const bad of ['..', '.']) {
      const { client, calls } = fakeClient();
      const result = await c.tool.handler(client, { ...c.args, [key]: bad, confirm: true });
      assert.equal(result.isError, true, `${name} ${bad}`);
      assert.deepEqual(calls, [], `${name} must make no request for ${bad}`);
    }
  }
});

test('writes: APIError maps to an error result', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'CONFLICT', message: 'VMs created from this snapshot still exist: web-2' }, { status: 409 });
  });
  const result = await deleteSnapshot.handler(client, { id: SNAP, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /still exist: web-2/);
});

test('snapshot descriptions tell the agent to snapshot before risky changes and that restore is the undo', () => {
  assert.match(createSnapshot.description, /BEFORE any risky change \(reinstall_service, resize_service/);
  assert.match(createSnapshot.description, /restore_snapshot is the undo/);
  assert.match(restoreSnapshot.description, /the undo for a change that went wrong/);
  assert.match(restoreSnapshot.description, /root disk is replaced/);
});

test('create_snapshot: name bounds 1-64 in zod and JSON schema', async () => {
  const props = createSnapshot.inputSchema.properties.name as { minLength: number; maxLength: number };
  assert.equal(props.minLength, 1);
  assert.equal(props.maxLength, 64);
  for (const name of ['', 'x'.repeat(65)]) {
    const { client, calls } = fakeClient();
    const result = await createSnapshot.handler(client, { service_id: VM, name, confirm: true });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, []);
  }
});

test('restore_snapshot: a snapshotId that is not a UUID is refused before any request', async () => {
  const { client, calls } = fakeClient();
  const result = await restoreSnapshot.handler(client, { service_id: VM, snapshotId: 'snap-1', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /snapshotId/);
  assert.deepEqual(calls, []);
});

test('request_quota_increase: invalid requests are refused before any request', async () => {
  for (const args of [
    { requested: {}, reason: 'scaling the prod cluster' },
    { requested: { cores: 0 }, reason: 'scaling the prod cluster' },
    { requested: { cores: -2 }, reason: 'scaling the prod cluster' },
    { requested: { object_storage_tb: -1 }, reason: 'scaling the prod cluster' },
    { requested: { sandboxes: 201 }, reason: 'scaling the prod cluster' },
    { requested: { gpus: 1 }, reason: 'scaling the prod cluster' },
    { requested: { cores: 16 }, reason: 'more' },
    { requested: { cores: 16 }, reason: 'scaling the prod cluster', context: { kind: 'k8s', blob: 'x'.repeat(5000) } },
  ]) {
    const { client, calls } = fakeClient();
    const result = await requestQuotaIncrease.handler(client, { ...args, confirm: true });
    assert.equal(result.isError, true, JSON.stringify(args).slice(0, 120));
    assert.deepEqual(calls, []);
  }
});

test('request_quota_increase: -1 (unlimited) is accepted for an OpenStack resource; context is optional', async () => {
  const { client, calls } = fakeClient();
  await requestQuotaIncrease.handler(client, { requested: { floatingip: -1 }, reason: 'need many public IPs', confirm: true });
  assert.deepEqual(calls[0].body, { requested: { floatingip: -1 }, reason: 'need many public IPs' });
});

test('set_service_rdns: hostname bounds 1-254; no IP input exists', async () => {
  assert.ok(!('ip' in setServiceRdns.inputSchema.properties));
  for (const hostname of ['', 'a'.repeat(255)]) {
    const { client, calls } = fakeClient();
    const result = await setServiceRdns.handler(client, { service_id: VM, hostname, confirm: true });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, []);
  }
  const { client } = fakeClient();
  const result = await setServiceRdns.handler(client, { service_id: VM, hostname: 'mail.example.com', ip: '1.2.3.4', confirm: true });
  assert.equal(result.isError, true, 'an ip argument is rejected (strict schema)');
});
