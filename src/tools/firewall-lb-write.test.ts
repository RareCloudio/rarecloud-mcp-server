// Unit tests for the Parity Phase B firewall + load-balancer WRITE tools
// (Task 6): firewalls (create/delete/add-rule/delete-rule/attach/detach) and
// load balancers (create/delete/add-member/remove-member). A fake client
// records method+path+body (no network); we assert closed schemas, path +
// segment encoding, exact body shapes (incl. omit-undefined optionals), the
// confirm/destructive gates, and the traversal guard on every dynamic
// segment (id, and the second segment ruleId/memberId where present).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFirewall,
  deleteFirewall,
  addFirewallRule,
  deleteFirewallRule,
  attachFirewall,
  detachFirewall,
  createLoadBalancer,
  deleteLoadBalancer,
  addLoadBalancerMember,
  removeLoadBalancerMember,
} from './firewall-lb-write.js';
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
// Shared table: the 8 tools with a single dynamic path segment, `id`
// (create_firewall / create_load_balancer have NO id segment — they create
// new resources — and get their own dedicated tests further down). Two of
// these (delete_firewall_rule, remove_load_balancer_member) also carry a
// SECOND dynamic segment (ruleId / memberId).
// ---------------------------------------------------------------------------
type IdToolCase = {
  tool: ToolDefinition;
  gated: boolean; // advertises confirm
  destructive: boolean; // advertises annotations.destructiveHint
  args: Record<string, unknown>; // required domain args minus id
  secondSeg?: 'ruleId' | 'memberId';
};

const ID_TOOLS: Record<string, IdToolCase> = {
  delete_firewall: { tool: deleteFirewall, gated: true, destructive: true, args: {} },
  add_firewall_rule: {
    tool: addFirewallRule,
    gated: false,
    destructive: false,
    args: { direction: 'inbound', protocol: 'tcp' },
  },
  delete_firewall_rule: {
    tool: deleteFirewallRule,
    gated: true,
    destructive: true,
    args: { ruleId: 'rule-1' },
    secondSeg: 'ruleId',
  },
  attach_firewall: { tool: attachFirewall, gated: false, destructive: false, args: { serverId: 'srv-1' } },
  detach_firewall: { tool: detachFirewall, gated: false, destructive: false, args: { serverId: 'srv-1' } },
  delete_load_balancer: { tool: deleteLoadBalancer, gated: true, destructive: true, args: {} },
  add_load_balancer_member: {
    tool: addLoadBalancerMember,
    gated: false,
    destructive: false,
    args: { serverId: 'srv-1', port: 80 },
  },
  remove_load_balancer_member: {
    tool: removeLoadBalancerMember,
    gated: true,
    destructive: true,
    args: { memberId: 'mem-1' },
    secondSeg: 'memberId',
  },
};

test('task6 registry: each id-tool has its name, closed schema, requires id, services:write in description', () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.match(c.tool.description, /services:write/, `${name} description must name the scope`);
    assert.ok((c.tool.inputSchema.required ?? []).includes('id'), `${name} must require id`);
    if (c.secondSeg) {
      assert.ok((c.tool.inputSchema.required ?? []).includes(c.secondSeg), `${name} must require ${c.secondSeg}`);
    }
  }
});

test('task6 gates: confirm advertised iff gated; destructiveHint iff destructive', () => {
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

test('task6 confirm gate: gated tools refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { id: 'res-1', ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('task6 traversal guard: a ".." id is rejected before any request', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { id: '..', ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

test('task6 traversal guard: a ".." second segment (ruleId / memberId) is rejected before any request', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    if (!c.secondSeg) continue;
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const badSeg = { ...c.args, [c.secondSeg]: '..' };
    const result = await c.tool.handler(client, { id: 'fw-1', ...badSeg, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".." on ${c.secondSeg}`);
    assert.equal(textOf(result), `Error: Invalid ${c.secondSeg} value`, `${name} ${c.secondSeg} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".." on ${c.secondSeg}`);
  }
});

test('task6 APIError mapping: a representative tool maps [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await attachFirewall.handler(client, { id: 'fw-1', serverId: 'srv-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});

// --- create_firewall (POST /v1/firewalls, no gate) -------------------------

test('create_firewall: name + closed schema (no confirm — not gated per brief)', () => {
  assert.equal(createFirewall.name, 'create_firewall');
  assert.match(createFirewall.description, /services:write/);
  assert.deepEqual(createFirewall.inputSchema.required, ['name']);
  assert.ok(!('confirm' in createFirewall.inputSchema.properties));
  assert.equal(createFirewall.annotations, undefined);
});

test('create_firewall: POSTs {name} to /v1/firewalls', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createFirewall.handler(client, { name: 'web-sg' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/firewalls', body: { name: 'web-sg' } }]);
});

test('create_firewall: rejects an empty name before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createFirewall.handler(client, { name: '' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_firewall:/);
  assert.deepEqual(calls, []);
});

test('create_firewall: rejects a name over 63 chars before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createFirewall.handler(client, { name: 'x'.repeat(64) });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_firewall:/);
  assert.deepEqual(calls, []);
});

test('create_firewall: schema mirrors name minLength/maxLength (63, per openapi)', () => {
  const props = createFirewall.inputSchema.properties as Record<string, { minLength?: number; maxLength?: number }>;
  assert.equal(props.name.minLength, 1);
  assert.equal(props.name.maxLength, 63);
});

// --- delete_firewall (DELETE /v1/firewalls/{id}, confirm+destr) ------------

test('delete_firewall: DELETEs /v1/firewalls/{id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteFirewall.handler(client, { id: 'fw 1/2', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/firewalls/fw%201%2F2' }]);
});

// --- add_firewall_rule (POST /v1/firewalls/{id}/rules, no gate) -----------

test('add_firewall_rule: name + closed schema, requires direction+protocol (no confirm)', () => {
  assert.equal(addFirewallRule.name, 'add_firewall_rule');
  assert.match(addFirewallRule.description, /services:write/);
  assert.deepEqual(addFirewallRule.inputSchema.required, ['id', 'direction', 'protocol']);
  assert.ok(!('confirm' in addFirewallRule.inputSchema.properties));
  assert.equal(addFirewallRule.annotations, undefined);
});

test('add_firewall_rule: POSTs the bare FirewallRuleInput (not wrapped) with only required fields', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addFirewallRule.handler(client, { id: 'fw-1', direction: 'inbound', protocol: 'tcp' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/firewalls/fw-1/rules', body: { direction: 'inbound', protocol: 'tcp' } },
  ]);
});

test('add_firewall_rule: forwards all optional fields when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addFirewallRule.handler(client, {
    id: 'fw-1',
    direction: 'inbound',
    protocol: 'tcp',
    portRangeMin: 80,
    portRangeMax: 443,
    remoteCidr: '0.0.0.0/0',
    description: 'web',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/firewalls/fw-1/rules',
      body: {
        direction: 'inbound',
        protocol: 'tcp',
        portRangeMin: 80,
        portRangeMax: 443,
        remoteCidr: '0.0.0.0/0',
        description: 'web',
      },
    },
  ]);
});

test('add_firewall_rule: rejects an invalid direction before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addFirewallRule.handler(client, { id: 'fw-1', direction: 'sideways', protocol: 'tcp' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_firewall_rule:/);
  assert.deepEqual(calls, []);
});

test('add_firewall_rule: rejects an invalid protocol before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addFirewallRule.handler(client, { id: 'fw-1', direction: 'inbound', protocol: 'sctp' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_firewall_rule:/);
  assert.deepEqual(calls, []);
});

test('add_firewall_rule: rejects portRangeMin below 1 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addFirewallRule.handler(client, {
    id: 'fw-1',
    direction: 'inbound',
    protocol: 'tcp',
    portRangeMin: 0,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_firewall_rule:/);
  assert.deepEqual(calls, []);
});

test('add_firewall_rule: rejects portRangeMax above 65535 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addFirewallRule.handler(client, {
    id: 'fw-1',
    direction: 'inbound',
    protocol: 'tcp',
    portRangeMax: 65536,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_firewall_rule:/);
  assert.deepEqual(calls, []);
});

test('add_firewall_rule: rejects a description over 255 chars before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addFirewallRule.handler(client, {
    id: 'fw-1',
    direction: 'inbound',
    protocol: 'tcp',
    description: 'x'.repeat(256),
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_firewall_rule:/);
  assert.deepEqual(calls, []);
});

test('add_firewall_rule: schema mirrors direction/protocol enums, port bounds (incl. min side), description maxLength', () => {
  const props = addFirewallRule.inputSchema.properties as Record<
    string,
    { enum?: string[]; minimum?: number; maximum?: number; maxLength?: number }
  >;
  assert.deepEqual(props.direction.enum, ['inbound', 'outbound']);
  assert.deepEqual(props.protocol.enum, ['tcp', 'udp', 'icmp', 'all']);
  assert.equal(props.portRangeMin.minimum, 1);
  assert.equal(props.portRangeMin.maximum, 65535);
  assert.equal(props.portRangeMax.minimum, 1);
  assert.equal(props.portRangeMax.maximum, 65535);
  assert.equal(props.description.maxLength, 255);
});

// --- delete_firewall_rule (DELETE .../rules/{ruleId}, confirm+destr) ------

test('delete_firewall_rule: DELETEs /v1/firewalls/{id}/rules/{ruleId} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteFirewallRule.handler(client, { id: 'fw-1', ruleId: 'rule 1/2', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/firewalls/fw-1/rules/rule%201%2F2' }]);
});

// --- attach_firewall / detach_firewall (POST {serverId}, no gate) ---------

test('attach_firewall: POSTs {serverId} to /v1/firewalls/{id}/attach', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachFirewall.handler(client, { id: 'fw-1', serverId: 'srv-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/firewalls/fw-1/attach', body: { serverId: 'srv-1' } }]);
});

test('attach_firewall: missing serverId is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await attachFirewall.handler(client, { id: 'fw-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for attach_firewall:/);
  assert.deepEqual(calls, []);
});

test('detach_firewall: POSTs {serverId} to /v1/firewalls/{id}/detach', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await detachFirewall.handler(client, { id: 'fw-1', serverId: 'srv-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/firewalls/fw-1/detach', body: { serverId: 'srv-1' } }]);
});

test('detach_firewall: missing serverId is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await detachFirewall.handler(client, { id: 'fw-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for detach_firewall:/);
  assert.deepEqual(calls, []);
});

// --- create_load_balancer (POST /v1/load-balancers, no gate per brief) ----

test('create_load_balancer: name + closed schema (no confirm — plain write per sweep)', () => {
  assert.equal(createLoadBalancer.name, 'create_load_balancer');
  assert.match(createLoadBalancer.description, /services:write/);
  assert.deepEqual(createLoadBalancer.inputSchema.required, ['name', 'port', 'memberServerIds']);
  assert.ok(!('confirm' in createLoadBalancer.inputSchema.properties));
  assert.equal(createLoadBalancer.annotations, undefined);
});

test('create_load_balancer: POSTs required fields to /v1/load-balancers (healthCheck omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createLoadBalancer.handler(client, {
    name: 'web-lb',
    port: 80,
    memberServerIds: ['srv-1', 'srv-2'],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/load-balancers',
      body: { name: 'web-lb', port: 80, memberServerIds: ['srv-1', 'srv-2'] },
    },
  ]);
});

test('create_load_balancer: forwards optional healthCheck when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createLoadBalancer.handler(client, {
    name: 'web-lb',
    port: 80,
    memberServerIds: ['srv-1'],
    healthCheck: false,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/load-balancers',
      body: { name: 'web-lb', port: 80, memberServerIds: ['srv-1'], healthCheck: false },
    },
  ]);
});

test('create_load_balancer: rejects an empty name before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createLoadBalancer.handler(client, { name: '', port: 80, memberServerIds: ['srv-1'] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_load_balancer:/);
  assert.deepEqual(calls, []);
});

test('create_load_balancer: rejects a name over 253 chars before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createLoadBalancer.handler(client, {
    name: 'x'.repeat(254),
    port: 80,
    memberServerIds: ['srv-1'],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_load_balancer:/);
  assert.deepEqual(calls, []);
});

test('create_load_balancer: rejects port below 1 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createLoadBalancer.handler(client, { name: 'web-lb', port: 0, memberServerIds: ['srv-1'] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_load_balancer:/);
  assert.deepEqual(calls, []);
});

test('create_load_balancer: rejects port above 65535 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createLoadBalancer.handler(client, {
    name: 'web-lb',
    port: 65536,
    memberServerIds: ['srv-1'],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_load_balancer:/);
  assert.deepEqual(calls, []);
});

test('create_load_balancer: rejects an empty memberServerIds array before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createLoadBalancer.handler(client, { name: 'web-lb', port: 80, memberServerIds: [] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_load_balancer:/);
  assert.deepEqual(calls, []);
});

test('create_load_balancer: schema mirrors name minLength/maxLength, port bounds (incl. min side), minItems', () => {
  const props = createLoadBalancer.inputSchema.properties as Record<
    string,
    { minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number }
  >;
  assert.equal(props.name.minLength, 1);
  assert.equal(props.name.maxLength, 253);
  assert.equal(props.port.minimum, 1);
  assert.equal(props.port.maximum, 65535);
  assert.equal(props.memberServerIds.minItems, 1);
});

// --- delete_load_balancer (DELETE /v1/load-balancers/{id}, confirm+destr) -

test('delete_load_balancer: DELETEs /v1/load-balancers/{id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteLoadBalancer.handler(client, { id: 'lb-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/load-balancers/lb-1' }]);
});

// --- add_load_balancer_member (POST {serverId,port}, no gate) -------------

test('add_load_balancer_member: POSTs {serverId,port} to /v1/load-balancers/{id}/members', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addLoadBalancerMember.handler(client, { id: 'lb-1', serverId: 'srv-1', port: 8080 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/load-balancers/lb-1/members', body: { serverId: 'srv-1', port: 8080 } },
  ]);
});

test('add_load_balancer_member: missing port is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addLoadBalancerMember.handler(client, { id: 'lb-1', serverId: 'srv-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_load_balancer_member:/);
  assert.deepEqual(calls, []);
});

test('add_load_balancer_member: rejects port above 65535 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addLoadBalancerMember.handler(client, { id: 'lb-1', serverId: 'srv-1', port: 65536 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_load_balancer_member:/);
  assert.deepEqual(calls, []);
});

test('add_load_balancer_member: schema mirrors port bounds (incl. min side)', () => {
  const props = addLoadBalancerMember.inputSchema.properties as Record<string, { minimum?: number; maximum?: number }>;
  assert.equal(props.port.minimum, 1);
  assert.equal(props.port.maximum, 65535);
});

// --- remove_load_balancer_member (DELETE .../members/{memberId}, confirm+destr)

test('remove_load_balancer_member: DELETEs /v1/load-balancers/{id}/members/{memberId} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await removeLoadBalancerMember.handler(client, { id: 'lb-1', memberId: 'mem 1/2', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/load-balancers/lb-1/members/mem%201%2F2' }]);
});
