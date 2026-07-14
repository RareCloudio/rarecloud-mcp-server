// Unit tests for the cloud-infrastructure detail reads added in Task 5:
// firewalls (list + detail), a single volume, a single network, and the
// dedicated load-balancer members list. A fake client records the constructed
// path and returns a canned payload — no network. (The list_* reads and
// get_load_balancer are exercised via the shared factories in
// factories.test.ts; these tests pin the Task-5 additions specifically.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listFirewalls,
  getFirewall,
  getVolume,
  getNetwork,
  listLoadBalancerMembers,
} from './infra.js';
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

// --- list_firewalls (fixed, no input) --------------------------------------

test('infra: list_firewalls — name, GETs /v1/firewalls, empty closed schema', async () => {
  assert.equal(listFirewalls.name, 'list_firewalls');
  assert.ok(listFirewalls.description.trim().length > 0);
  assert.deepEqual(listFirewalls.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  const { client, calls } = fakeClient(() => [{ id: 'fw-123' }]);
  const result = await listFirewalls.handler(client, {});
  assert.deepEqual(calls, ['/v1/firewalls']);
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: 'fw-123' }]);
});

// --- single-id detail reads (firewall / volume / network) ------------------
// [tool, name, prefix] — path is `${prefix}/{id}`, JSON out.
const idScoped: Array<[ToolDefinition, string, string]> = [
  [getFirewall, 'get_firewall', '/v1/firewalls'],
  [getVolume, 'get_volume', '/v1/volumes'],
  [getNetwork, 'get_network', '/v1/networks'],
];

for (const [tool, name, prefix] of idScoped) {
  test(`infra: ${name} — encodes id into ${prefix}/{id}`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    const { client, calls } = fakeClient(() => ({ id: 'a b/c' }));
    await tool.handler(client, { id: 'a b/c' });
    assert.deepEqual(calls, [`${prefix}/a%20b%2Fc`]);
  });

  test(`infra: ${name} — requires id (closed schema, only id)`, () => {
    assert.deepEqual(tool.inputSchema.required, ['id']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
  });

  test(`infra: ${name} — APIError maps to errorResult`, async () => {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'NOT_FOUND', message: 'no such resource' });
    });
    const result = await tool.handler(client, { id: 'fw-123' });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: [NOT_FOUND] no such resource');
  });
}

// --- list_load_balancer_members (sub-path read) ----------------------------

test('infra: list_load_balancer_members — encodes id into /v1/load-balancers/{id}/members', async () => {
  assert.equal(listLoadBalancerMembers.name, 'list_load_balancer_members');
  assert.ok(listLoadBalancerMembers.description.trim().length > 0);
  const { client, calls } = fakeClient(() => ({ members: [] }));
  await listLoadBalancerMembers.handler(client, { id: 'lb 1/2' });
  assert.deepEqual(calls, ['/v1/load-balancers/lb%201%2F2/members']);
});

test('infra: list_load_balancer_members — requires id (closed schema, only id)', () => {
  assert.deepEqual(listLoadBalancerMembers.inputSchema.required, ['id']);
  assert.equal(listLoadBalancerMembers.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(listLoadBalancerMembers.inputSchema.properties), ['id']);
});

test('infra: list_load_balancer_members — returns the payload as JSON text', async () => {
  const { client } = fakeClient(() => ({ members: [{ ip: '10.0.0.5', port: 8080 }] }));
  const result = await listLoadBalancerMembers.handler(client, { id: 'lb-123' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { members: [{ ip: '10.0.0.5', port: 8080 }] });
});

test('infra: list_load_balancer_members — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'no such load balancer' });
  });
  const result = await listLoadBalancerMembers.handler(client, { id: 'lb-123' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [NOT_FOUND] no such load balancer');
});
