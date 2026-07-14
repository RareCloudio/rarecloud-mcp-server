// Cloud infra WRITE tools (Parity Phase B, Task 5): block volumes, private
// networks (VPCs), and reserved (static) public IPs. Everything here builds on
// the shared `writeTool` factory so input validation, the confirm gate,
// `encodeSegment` path encoding, and the APIError -> errorResult mapping stay
// uniform with services-write.ts / k8s-write.ts. All scope services:write.
//
// Money-spend tools (create_volume, reserve_ip — both per-unit billed
// on-demand resources) carry `confirm: true`; irreversible teardown tools
// (delete_volume, delete_network, release_reserved_ip) carry `confirm: true` +
// `destructiveHint`. Plain moves (attach/detach) are ungated. Every dynamic
// path segment is the single param `id` (matching the read-tool convention in
// infra.ts) run through encodeSegment; `serverId` is a BODY field, never a
// path segment. Bodies + bounds re-confirmed against console openapi.json AND
// the route source (api/src/routes/v1-volumes.ts, v1-networks.ts,
// v1-reserved-ips.ts) — all three METHOD/path/body shapes matched the brief
// exactly; the only additions are openapi's `name` maxLength:253 bounds (not
// spelled out in the brief's bare `string` cells), mirrored in both zod and
// the JSON inputSchema per the Task-4 review nit (minLength/maxLength on
// every zod `.min()`/`.max()`).

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

// --- volumes ----------------------------------------------------------------

export const createVolume: ToolDefinition = writeTool({
  name: 'create_volume',
  description:
    'Create a new block storage volume (Cinder). Requires scope services:write. SPENDS MONEY: billed ' +
    'per-GB monthly, not a catalog SKU. Pass confirm:true only after the user has approved the size and ' +
    'its cost. sizeGb is the size in GB (1-2048); name is an optional display name (max 253 chars, ' +
    "defaults to 'volume' server-side). Attach it to a VM afterward with attach_volume.",
  method: 'POST',
  input: z
    .object({
      sizeGb: z.number().int().min(1).max(2048),
      name: z.string().max(253).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      sizeGb: { type: 'integer', minimum: 1, maximum: 2048, description: 'Volume size in GB (1-2048).' },
      name: { type: 'string', maxLength: 253, description: "Optional display name (default 'volume')." },
    },
    required: ['sizeGb'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/volumes',
  buildBody: (a) => {
    const body: Record<string, unknown> = { sizeGb: a.sizeGb };
    if (a.name !== undefined) body.name = a.name;
    return body;
  },
  confirm: true,
});

export const deleteVolume: ToolDefinition = writeTool({
  name: 'delete_volume',
  description:
    'Delete a block storage volume permanently. Requires scope services:write. IRREVERSIBLE: the volume ' +
    'and its data are gone for good. Pass confirm:true only after the user has explicitly approved. id ' +
    'comes from list_volumes.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Volume id from list_volumes.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/volumes/${encodeSegment(a.id, 'id')}`,
  confirm: true,
  destructiveHint: true,
});

export const attachVolume: ToolDefinition = writeTool({
  name: 'attach_volume',
  description:
    'Attach a block storage volume to a cloud VM. Requires scope services:write. Plain write — not ' +
    'gated. id (the volume) comes from list_volumes; serverId is the Nova server id to attach to (must ' +
    'be in your project).',
  method: 'POST',
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Volume id from list_volumes.' },
      serverId: { type: 'string', minLength: 1, description: 'Nova server id to attach to (must be in your project).' },
    },
    required: ['id', 'serverId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/volumes/${encodeSegment(a.id, 'id')}/attach`,
  buildBody: (a) => ({ serverId: a.serverId }),
});

export const detachVolume: ToolDefinition = writeTool({
  name: 'detach_volume',
  description:
    'Detach a block storage volume from a cloud VM. Requires scope services:write. Plain write — not ' +
    'gated. id (the volume) comes from list_volumes; serverId is the Nova server id to detach from.',
  method: 'POST',
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Volume id from list_volumes.' },
      serverId: { type: 'string', minLength: 1, description: 'Nova server id to detach from.' },
    },
    required: ['id', 'serverId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/volumes/${encodeSegment(a.id, 'id')}/detach`,
  buildBody: (a) => ({ serverId: a.serverId }),
});

// --- networks (VPCs) --------------------------------------------------------

export const createNetwork: ToolDefinition = writeTool({
  name: 'create_network',
  description:
    'Create a new private network (VPC). Requires scope services:write. Plain write — not gated (VPCs ' +
    'carry no separate charge). name is the display name (1-253 chars); a /16 CIDR is auto-allocated. ' +
    'Move VMs into it afterward with attach_network_vm.',
  method: 'POST',
  input: z.object({ name: z.string().min(1).max(253) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 253, description: 'VPC display name.' } },
    required: ['name'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/networks',
  buildBody: (a) => ({ name: a.name }),
});

export const deleteNetwork: ToolDefinition = writeTool({
  name: 'delete_network',
  description:
    'Delete a private network (VPC). Requires scope services:write. IRREVERSIBLE, and refused server-side ' +
    'for the default VPC or one that still has VMs attached. Pass confirm:true only after the user has ' +
    'explicitly approved. id comes from list_networks.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'VPC id from list_networks.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/networks/${encodeSegment(a.id, 'id')}`,
  confirm: true,
  destructiveHint: true,
});

export const attachNetworkVm: ToolDefinition = writeTool({
  name: 'attach_network_vm',
  description:
    'Move a cloud VM into a private network (VPC), detaching it from its current VPC (the VM\'s public ' +
    'eth0 interface is untouched). Requires scope services:write. Plain write — not gated. id is the ' +
    'target VPC from list_networks; serverId is the Nova server id to move.',
  method: 'POST',
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Target VPC (network) id from list_networks.' },
      serverId: { type: 'string', minLength: 1, description: 'Nova server id to move into this VPC.' },
    },
    required: ['id', 'serverId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/networks/${encodeSegment(a.id, 'id')}/vms`,
  buildBody: (a) => ({ serverId: a.serverId }),
});

// --- reserved IPs ------------------------------------------------------------

export const reserveIp: ToolDefinition = writeTool({
  name: 'reserve_ip',
  description:
    'Reserve a new static public IP (EUR 2/mo). Requires scope services:write. SPENDS MONEY: billed ' +
    'monthly until released. Optionally pass serverId to reserve AND attach it to that cloud VM in the ' +
    'same call. Pass confirm:true only after the user has approved the cost. Manage it afterward with ' +
    'attach_reserved_ip / detach_reserved_ip / release_reserved_ip.',
  method: 'POST',
  input: z.object({ serverId: z.string().min(1).optional() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        minLength: 1,
        description: 'Optional cloud VM id to attach the new IP to immediately.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  buildPath: () => '/v1/reserved-ips',
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.serverId !== undefined) body.serverId = a.serverId;
    return body;
  },
  confirm: true,
});

export const releaseReservedIp: ToolDefinition = writeTool({
  name: 'release_reserved_ip',
  description:
    'Release (permanently delete) a reserved public IP. Requires scope services:write. IRREVERSIBLE: the ' +
    'floating IP is deleted and billing stops. Pass confirm:true only after the user has explicitly ' +
    'approved. id comes from list_reserved_ips.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Reserved IP id from list_reserved_ips.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/reserved-ips/${encodeSegment(a.id, 'id')}`,
  confirm: true,
  destructiveHint: true,
});

export const attachReservedIp: ToolDefinition = writeTool({
  name: 'attach_reserved_ip',
  description:
    'Attach a reserved (static) public IP to one of your cloud VMs. Requires scope services:write. Plain ' +
    'write — not gated. id comes from list_reserved_ips; serverId is the cloud VM id to attach to (must ' +
    'be owned by you).',
  method: 'POST',
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Reserved IP id from list_reserved_ips.' },
      serverId: { type: 'string', minLength: 1, description: 'Cloud VM id to attach to (must be owned by you).' },
    },
    required: ['id', 'serverId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/reserved-ips/${encodeSegment(a.id, 'id')}/attach`,
  buildBody: (a) => ({ serverId: a.serverId }),
});

// CONFIRMED (not a deviation): via console openapi.json AND the route source
// api/src/routes/v1-reserved-ips.ts — both agree — the detach endpoint takes
// NO request body at all (no requestBody in openapi; the handler reads only
// the path segment). The brief's own Notes column already called this out
// ("no body per openapi"), so this is a confirmation, not a contradiction —
// omitting `buildBody` entirely (not even an empty-object one) matches the
// live contract, and per the task's DELETE/body rule this is a POST so no
// NEEDS_CONTEXT applies.
export const detachReservedIp: ToolDefinition = writeTool({
  name: 'detach_reserved_ip',
  description:
    'Detach a reserved public IP from its VM. The IP stays allocated and billed until you release it ' +
    'with release_reserved_ip. Requires scope services:write. Plain write — not gated. id comes from ' +
    'list_reserved_ips.',
  method: 'POST',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Reserved IP id from list_reserved_ips.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/reserved-ips/${encodeSegment(a.id, 'id')}/detach`,
});
