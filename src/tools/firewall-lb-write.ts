// Cloud infra WRITE tools (Parity Phase B, Task 6): firewalls (security
// groups) and load balancers. Everything here builds on the shared
// `writeTool` factory so input validation, the confirm gate, `encodeSegment`
// path encoding, and the APIError -> errorResult mapping stay uniform with
// infra-write.ts / services-write.ts / k8s-write.ts. All scope
// services:write.
//
// Irreversible teardown tools (delete_firewall, delete_firewall_rule,
// delete_load_balancer, remove_load_balancer_member) carry `confirm: true` +
// `destructiveHint`. Plain creates/moves (create_firewall, add_firewall_rule,
// attach/detach_firewall, create_load_balancer, add_load_balancer_member) are
// ungated per the brief's sweep — none of these are separately billed
// on-demand resources, so unlike create_volume/reserve_ip they don't get the
// money-spend confirm gate. Every dynamic path segment (`id`, and the
// firewall-rule/LB-member second segment) runs through encodeSegment;
// `serverId` is always a BODY field, never a path segment.
//
// Bodies + bounds re-confirmed against console openapi.json AND the route
// source (api/src/routes/v1-firewalls.ts, v1-load-balancers.ts):
//
//   - create_firewall: openapi documents name minLength:1 maxLength:63
//     (brief's bare `name:string` cell under-specifies this) — mirrored in
//     both zod and the JSON inputSchema.
//   - add_firewall_rule: the body IS the bare FirewallRuleInput (not
//     wrapped), matching the brief. openapi documents description
//     maxLength:255 (not spelled out in the brief) — mirrored in both
//     layers. The route source additionally enforces remoteCidr against a
//     CIDR-format regex and a portRangeMin<=portRangeMax cross-field rule;
//     neither is part of the openapi-documented request schema, so — per the
//     Task-5 precedent of only mirroring openapi-documented bounds
//     client-side — we do not replicate them here; an invalid value still
//     surfaces as a server-side APIError.
//   - create_load_balancer: openapi documents name maxLength:253 but is
//     silent on a minimum; the route source's CreateLbBody enforces
//     `.min(1)`, so we mirror minLength:1 too (ambiguity resolved via route
//     source per the task's allowance, matching the same 253 bound and
//     min(1)-on-name pattern already used for create_network in
//     infra-write.ts).
//   - remove_load_balancer_member: openapi names the second path parameter
//     `mid`; we keep the brief's `memberId` as the zod/tool field name since
//     that's a naming choice for our own args object, not part of the wire
//     path (buildPath interpolates the value positionally, so the openapi
//     parameter name is documentation-only and doesn't affect behavior).
//
// All other METHOD/path/body shapes matched the brief exactly.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

// --- firewalls ---------------------------------------------------------------

export const createFirewall: ToolDefinition = writeTool({
  name: 'create_firewall',
  description:
    'Create a new cloud firewall (security group). Requires scope services:write. Plain write — not ' +
    'gated. name is the display name (1-63 chars). Add rules with add_firewall_rule, then attach it to a ' +
    'VM with attach_firewall.',
  method: 'POST',
  input: z.object({ name: z.string().min(1).max(63) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 63, description: 'Firewall display name.' } },
    required: ['name'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/firewalls',
  buildBody: (a) => ({ name: a.name }),
});

export const deleteFirewall: ToolDefinition = writeTool({
  name: 'delete_firewall',
  description:
    'Delete a cloud firewall. Requires scope services:write. IRREVERSIBLE, and refused server-side while ' +
    'it is still attached to any VM (detach first with detach_firewall). Pass confirm:true only after the ' +
    'user has explicitly approved. id comes from list_firewalls.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Firewall id from list_firewalls.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/firewalls/${encodeSegment(a.id, 'id')}`,
  confirm: true,
  destructiveHint: true,
});

export const addFirewallRule: ToolDefinition = writeTool({
  name: 'add_firewall_rule',
  description:
    'Add an inbound/outbound rule to a cloud firewall. Requires scope services:write. Plain write — not ' +
    'gated. id is the firewall id from list_firewalls / get_firewall. direction and protocol are required; ' +
    'portRangeMin/portRangeMax (1-65535) narrow the rule to specific ports (omit both to match all ports); ' +
    "remoteCidr restricts the rule to a CIDR block (e.g. '0.0.0.0/0'); description is an optional label " +
    '(max 255 chars).',
  method: 'POST',
  input: z
    .object({
      id: z.string().min(1),
      direction: z.enum(['inbound', 'outbound']),
      protocol: z.enum(['tcp', 'udp', 'icmp', 'all']),
      portRangeMin: z.number().int().min(1).max(65535).optional(),
      portRangeMax: z.number().int().min(1).max(65535).optional(),
      remoteCidr: z.string().optional(),
      description: z.string().max(255).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Firewall id from list_firewalls / get_firewall.' },
      direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'Traffic direction the rule matches.' },
      protocol: { type: 'string', enum: ['tcp', 'udp', 'icmp', 'all'], description: 'Protocol the rule matches.' },
      portRangeMin: { type: 'integer', minimum: 1, maximum: 65535, description: 'Lower bound of the port range (1-65535).' },
      portRangeMax: { type: 'integer', minimum: 1, maximum: 65535, description: 'Upper bound of the port range (1-65535).' },
      remoteCidr: { type: 'string', description: "Remote CIDR block the rule applies to, e.g. '0.0.0.0/0'." },
      description: { type: 'string', maxLength: 255, description: 'Optional label for the rule (max 255 chars).' },
    },
    required: ['id', 'direction', 'protocol'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/firewalls/${encodeSegment(a.id, 'id')}/rules`,
  buildBody: (a) => {
    const body: Record<string, unknown> = { direction: a.direction, protocol: a.protocol };
    if (a.portRangeMin !== undefined) body.portRangeMin = a.portRangeMin;
    if (a.portRangeMax !== undefined) body.portRangeMax = a.portRangeMax;
    if (a.remoteCidr !== undefined) body.remoteCidr = a.remoteCidr;
    if (a.description !== undefined) body.description = a.description;
    return body;
  },
});

export const deleteFirewallRule: ToolDefinition = writeTool({
  name: 'delete_firewall_rule',
  description:
    'Remove a rule from a cloud firewall. Requires scope services:write. IRREVERSIBLE: the rule stops ' +
    'applying immediately, changing what traffic is allowed. Pass confirm:true only after the user has ' +
    'explicitly approved. id and ruleId both come from get_firewall.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1), ruleId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Firewall id from list_firewalls / get_firewall.' },
      ruleId: { type: 'string', minLength: 1, description: 'Rule id from get_firewall.' },
    },
    required: ['id', 'ruleId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/firewalls/${encodeSegment(a.id, 'id')}/rules/${encodeSegment(a.ruleId, 'ruleId')}`,
  confirm: true,
  destructiveHint: true,
});

export const attachFirewall: ToolDefinition = writeTool({
  name: 'attach_firewall',
  description:
    'Attach a cloud firewall to a cloud VM. Requires scope services:write. Plain write — not gated. id ' +
    'comes from list_firewalls; serverId is the Nova server id to attach to (must be in your project).',
  method: 'POST',
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Firewall id from list_firewalls.' },
      serverId: { type: 'string', minLength: 1, description: 'Nova server id to attach to (must be in your project).' },
    },
    required: ['id', 'serverId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/firewalls/${encodeSegment(a.id, 'id')}/attach`,
  buildBody: (a) => ({ serverId: a.serverId }),
});

export const detachFirewall: ToolDefinition = writeTool({
  name: 'detach_firewall',
  description:
    'Detach a cloud firewall from a cloud VM. Requires scope services:write. Plain write — not gated. id ' +
    'comes from list_firewalls; serverId is the Nova server id to detach from.',
  method: 'POST',
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Firewall id from list_firewalls.' },
      serverId: { type: 'string', minLength: 1, description: 'Nova server id to detach from.' },
    },
    required: ['id', 'serverId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/firewalls/${encodeSegment(a.id, 'id')}/detach`,
  buildBody: (a) => ({ serverId: a.serverId }),
});

// --- load balancers -----------------------------------------------------------

export const createLoadBalancer: ToolDefinition = writeTool({
  name: 'create_load_balancer',
  description:
    'Create a new L4 (TCP) load balancer: a VIP on your subnet, a listener + pool on port, the given VMs ' +
    'as members, and a public floating IP. Requires scope services:write and per-customer tenancy. Plain ' +
    'write — not gated. name is the display name (1-253 chars); port is the listener + member port ' +
    '(1-65535); memberServerIds are the Nova server ids to balance across (at least one); healthCheck ' +
    'enables a TCP health monitor (defaults to true server-side if omitted). Manage it afterward with ' +
    'add_load_balancer_member / remove_load_balancer_member.',
  method: 'POST',
  input: z
    .object({
      name: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      memberServerIds: z.array(z.string()).min(1),
      healthCheck: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 253, description: 'Load balancer display name.' },
      port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Listener + member port (1-65535).' },
      memberServerIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Nova server ids to balance across.',
      },
      healthCheck: { type: 'boolean', description: 'TCP health monitor (default true).' },
    },
    required: ['name', 'port', 'memberServerIds'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/load-balancers',
  buildBody: (a) => {
    const body: Record<string, unknown> = { name: a.name, port: a.port, memberServerIds: a.memberServerIds };
    if (a.healthCheck !== undefined) body.healthCheck = a.healthCheck;
    return body;
  },
});

export const deleteLoadBalancer: ToolDefinition = writeTool({
  name: 'delete_load_balancer',
  description:
    'Delete a load balancer. Requires scope services:write. IRREVERSIBLE: cascade-deletes the ' +
    'listener/pool/members/health-monitor and releases the VIP floating IP. Refused server-side for ' +
    'k8s-managed load balancers (manage those via the Kubernetes Service instead). Pass confirm:true only ' +
    'after the user has explicitly approved. id comes from list_load_balancers.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Load balancer id from list_load_balancers.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/load-balancers/${encodeSegment(a.id, 'id')}`,
  confirm: true,
  destructiveHint: true,
});

export const addLoadBalancerMember: ToolDefinition = writeTool({
  name: 'add_load_balancer_member',
  description:
    'Add a VM as a member of a load balancer pool. Requires scope services:write. Plain write — not ' +
    'gated. id comes from list_load_balancers; serverId is the Nova server id to add (must be in your ' +
    'project); port is the member port (1-65535).',
  method: 'POST',
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1), port: z.number().int().min(1).max(65535) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Load balancer id from list_load_balancers.' },
      serverId: { type: 'string', minLength: 1, description: 'Nova server id to add (must be in your project).' },
      port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Member port (1-65535).' },
    },
    required: ['id', 'serverId', 'port'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/load-balancers/${encodeSegment(a.id, 'id')}/members`,
  buildBody: (a) => ({ serverId: a.serverId, port: a.port }),
});

export const removeLoadBalancerMember: ToolDefinition = writeTool({
  name: 'remove_load_balancer_member',
  description:
    'Remove a member from a load balancer pool. Requires scope services:write. IRREVERSIBLE: the member ' +
    'stops receiving traffic immediately. Pass confirm:true only after the user has explicitly approved. ' +
    'id comes from list_load_balancers; memberId comes from list_load_balancer_members.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1), memberId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Load balancer id from list_load_balancers.' },
      memberId: { type: 'string', minLength: 1, description: 'Member id from list_load_balancer_members.' },
    },
    required: ['id', 'memberId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/load-balancers/${encodeSegment(a.id, 'id')}/members/${encodeSegment(a.memberId, 'memberId')}`,
  confirm: true,
  destructiveHint: true,
});
