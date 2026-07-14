// Unit tests for the Parity Phase B cloud-infra WRITE tools (Task 5): volumes
// (create/delete/attach/detach), networks/VPCs (create/delete/attach-vm), and
// reserved IPs (reserve/release/attach/detach). A fake client records
// method+path+body (no network); we assert closed schemas, path + segment
// encoding, exact body shapes (incl. omit-undefined optionals), the
// confirm/destructive gates, and the traversal guard on every dynamic `id`
// segment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVolume,
  deleteVolume,
  attachVolume,
  detachVolume,
  createNetwork,
  deleteNetwork,
  attachNetworkVm,
  reserveIp,
  releaseReservedIp,
  attachReservedIp,
  detachReservedIp,
} from './infra-write.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

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

// ---------------------------------------------------------------------------
// Shared table: the 8 tools with a single dynamic path segment, `id`. Drives
// the registry / gate / traversal assertions below. (create_volume,
// create_network, reserve_ip have NO id segment — they create new resources —
// and get their own dedicated tests further down.)
// ---------------------------------------------------------------------------
type IdToolCase = {
  tool: ToolDefinition;
  gated: boolean; // advertises confirm
  destructive: boolean; // advertises annotations.destructiveHint
  args: Record<string, unknown>; // required domain args minus id
};

const ID_TOOLS: Record<string, IdToolCase> = {
  delete_volume: { tool: deleteVolume, gated: true, destructive: true, args: {} },
  attach_volume: { tool: attachVolume, gated: false, destructive: false, args: { serverId: 'srv-1' } },
  detach_volume: { tool: detachVolume, gated: false, destructive: false, args: { serverId: 'srv-1' } },
  delete_network: { tool: deleteNetwork, gated: true, destructive: true, args: {} },
  attach_network_vm: { tool: attachNetworkVm, gated: false, destructive: false, args: { serverId: 'srv-1' } },
  release_reserved_ip: { tool: releaseReservedIp, gated: true, destructive: true, args: {} },
  attach_reserved_ip: { tool: attachReservedIp, gated: false, destructive: false, args: { serverId: 'srv-1' } },
  detach_reserved_ip: { tool: detachReservedIp, gated: false, destructive: false, args: {} },
};

test('task5 registry: each id-tool has its name, closed schema, requires id, services:write in description', () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.match(c.tool.description, /services:write/, `${name} description must name the scope`);
    assert.ok((c.tool.inputSchema.required ?? []).includes('id'), `${name} must require id`);
  }
});

test('task5 gates: confirm advertised iff gated; destructiveHint iff destructive', () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    const hasConfirm = 'confirm' in c.tool.inputSchema.properties;
    assert.equal(hasConfirm, c.gated, `${name}: confirm-in-schema must match gated=${c.gated}`);
    if (c.gated) {
      assert.ok((c.tool.inputSchema.required ?? []).includes('confirm'), `${name}: gated tool must require confirm`);
    } else {
      assert.ok(!('confirm' in c.tool.inputSchema.properties), `${name}: non-gated tool must not advertise confirm`);
    }
    assert.equal(
      c.tool.annotations?.destructiveHint ?? false,
      c.destructive,
      `${name}: destructiveHint must match destructive=${c.destructive}`,
    );
  }
});

test('task5 confirm gate: gated tools refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { id: 'res-1', ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('task5 traversal guard: a ".." id is rejected before any request', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { id: '..', ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

test('task5 APIError mapping: a representative tool maps [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await attachVolume.handler(client, { id: 'vol-1', serverId: 'srv-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});

// --- create_volume (POST /v1/volumes, confirm — per-GB priced) ------------

test('create_volume: name + closed schema (confirm — money-spend)', () => {
  assert.equal(createVolume.name, 'create_volume');
  assert.match(createVolume.description, /services:write/);
  assert.deepEqual(createVolume.inputSchema.required, ['sizeGb', 'confirm']);
  assert.equal(createVolume.inputSchema.additionalProperties, false);
  assert.equal(createVolume.annotations, undefined);
});

test('create_volume: POSTs {sizeGb} to /v1/volumes when confirmed (name omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createVolume.handler(client, { sizeGb: 50, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/volumes', body: { sizeGb: 50 } }]);
});

test('create_volume: forwards optional name when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createVolume.handler(client, { sizeGb: 50, name: 'data-disk', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/volumes', body: { sizeGb: 50, name: 'data-disk' } }]);
});

test('create_volume: refuses with NO request when confirm is absent', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createVolume.handler(client, { sizeGb: 50 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

test('create_volume: rejects sizeGb below 1 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createVolume.handler(client, { sizeGb: 0, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_volume:/);
  assert.deepEqual(calls, []);
});

test('create_volume: rejects sizeGb above 2048 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createVolume.handler(client, { sizeGb: 2049, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_volume:/);
  assert.deepEqual(calls, []);
});

test('create_volume: rejects a non-integer sizeGb before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createVolume.handler(client, { sizeGb: 1.5, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_volume:/);
  assert.deepEqual(calls, []);
});

test('create_volume: schema mirrors sizeGb bounds and name maxLength', () => {
  const props = createVolume.inputSchema.properties as Record<string, { minimum?: number; maximum?: number; maxLength?: number }>;
  assert.equal(props.sizeGb.minimum, 1);
  assert.equal(props.sizeGb.maximum, 2048);
  assert.equal(props.name.maxLength, 253);
});

// --- delete_volume (DELETE /v1/volumes/{id}, confirm+destr, no body) ------

test('delete_volume: DELETEs /v1/volumes/{id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteVolume.handler(client, { id: 'vol 1/2', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/volumes/vol%201%2F2' }]);
});

// --- attach_volume / detach_volume (POST {serverId}, no gate) -------------

test('attach_volume: POSTs {serverId} to /v1/volumes/{id}/attach', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachVolume.handler(client, { id: 'vol-1', serverId: 'srv-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/volumes/vol-1/attach', body: { serverId: 'srv-1' } }]);
});

test('attach_volume: missing serverId is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachVolume.handler(client, { id: 'vol-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for attach_volume:/);
  assert.deepEqual(calls, []);
});

test('detach_volume: POSTs {serverId} to /v1/volumes/{id}/detach', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await detachVolume.handler(client, { id: 'vol-1', serverId: 'srv-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/volumes/vol-1/detach', body: { serverId: 'srv-1' } }]);
});

// --- create_network (POST /v1/networks, no gate) --------------------------

test('create_network: name + closed schema (no confirm — not gated per brief)', () => {
  assert.equal(createNetwork.name, 'create_network');
  assert.match(createNetwork.description, /services:write/);
  assert.deepEqual(createNetwork.inputSchema.required, ['name']);
  assert.ok(!('confirm' in createNetwork.inputSchema.properties));
  assert.equal(createNetwork.annotations, undefined);
});

test('create_network: POSTs {name} to /v1/networks', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createNetwork.handler(client, { name: 'my-vpc' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/networks', body: { name: 'my-vpc' } }]);
});

test('create_network: rejects an empty name before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createNetwork.handler(client, { name: '' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_network:/);
  assert.deepEqual(calls, []);
});

test('create_network: rejects a name over 253 chars before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createNetwork.handler(client, { name: 'x'.repeat(254) });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_network:/);
  assert.deepEqual(calls, []);
});

test('create_network: schema mirrors name minLength/maxLength', () => {
  const props = createNetwork.inputSchema.properties as Record<string, { minLength?: number; maxLength?: number }>;
  assert.equal(props.name.minLength, 1);
  assert.equal(props.name.maxLength, 253);
});

// --- delete_network (DELETE /v1/networks/{id}, confirm+destr) -------------

test('delete_network: DELETEs /v1/networks/{id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteNetwork.handler(client, { id: 'net-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/networks/net-1' }]);
});

// --- attach_network_vm (POST {serverId}, no gate) -------------------------

test('attach_network_vm: POSTs {serverId} to /v1/networks/{id}/vms', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachNetworkVm.handler(client, { id: 'net-1', serverId: 'srv-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/networks/net-1/vms', body: { serverId: 'srv-1' } }]);
});

test('attach_network_vm: missing serverId is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachNetworkVm.handler(client, { id: 'net-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for attach_network_vm:/);
  assert.deepEqual(calls, []);
});

// --- reserve_ip (POST /v1/reserved-ips, confirm — billable) ---------------

test('reserve_ip: name + closed schema (confirm — money-spend), serverId optional/not required', () => {
  assert.equal(reserveIp.name, 'reserve_ip');
  assert.match(reserveIp.description, /services:write/);
  assert.deepEqual(reserveIp.inputSchema.required, ['confirm']);
  assert.equal(reserveIp.annotations, undefined);
});

test('reserve_ip: POSTs an empty body to /v1/reserved-ips when confirmed (serverId omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await reserveIp.handler(client, { confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/reserved-ips', body: {} }]);
});

test('reserve_ip: forwards serverId to reserve-and-attach in one call', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await reserveIp.handler(client, { serverId: 'srv-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/reserved-ips', body: { serverId: 'srv-1' } }]);
});

test('reserve_ip: refuses with NO request when confirm is absent', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await reserveIp.handler(client, {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

// --- release_reserved_ip (DELETE /v1/reserved-ips/{id}, confirm+destr) ----

test('release_reserved_ip: DELETEs /v1/reserved-ips/{id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await releaseReservedIp.handler(client, { id: 'ip-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/reserved-ips/ip-1' }]);
});

// --- attach_reserved_ip (POST {serverId}, no gate) ------------------------

test('attach_reserved_ip: POSTs {serverId} to /v1/reserved-ips/{id}/attach', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachReservedIp.handler(client, { id: 'ip-1', serverId: 'srv-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/reserved-ips/ip-1/attach', body: { serverId: 'srv-1' } }]);
});

test('attach_reserved_ip: missing serverId is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachReservedIp.handler(client, { id: 'ip-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for attach_reserved_ip:/);
  assert.deepEqual(calls, []);
});

// --- detach_reserved_ip (POST, NO body per openapi, no gate) --------------

test('detach_reserved_ip: closed schema requires only id (no serverId field)', () => {
  assert.deepEqual(detachReservedIp.inputSchema.required, ['id']);
  assert.deepEqual(Object.keys(detachReservedIp.inputSchema.properties), ['id']);
});

test('detach_reserved_ip: POSTs /v1/reserved-ips/{id}/detach with NO body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await detachReservedIp.handler(client, { id: 'ip-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/reserved-ips/ip-1/detach', body: undefined }]);
});

test('detach_reserved_ip: an unknown property (e.g. serverId) is rejected by the strict schema', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await detachReservedIp.handler(client, { id: 'ip-1', serverId: 'srv-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for detach_reserved_ip:/);
  assert.deepEqual(calls, []);
});
