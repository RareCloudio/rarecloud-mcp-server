// Cloud infra WRITE tools (Parity Phase B, Task 5): block volumes, private
// networks (VPCs), and reserved (static) public IPs. Everything here builds on
// the shared `writeTool` factory so input validation, the confirm gate,
// `encodeSegment` path encoding, and the APIError -> errorResult mapping stay
// uniform with services-write.ts / k8s-write.ts. All scope services:write.
//
// create_volume and reserve_ip (per-unit billed on-demand resources) are
// `spends`; delete_volume, delete_network, release_reserved_ip are
// `destructive`; the detach tools and attach_network_vm are `disruptive` (they
// cut a running VM off its storage, public address or private network);
// create_network, attach_volume and attach_reserved_ip are `plain`. Every dynamic
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
    `Create a new block storage volume (Cinder), billed per GB monthly (not a catalog SKU). Requires ` +
    `scope services:write. sizeGb is the size in GB (1-2048); name is an optional display name (max 253 ` +
    `chars, defaults to 'volume' server-side). Attach it to a VM afterward with attach_volume.`,
  method: 'POST',
  safety: {
    kind: 'spends',
    reason: "creates a volume billed per GB every month until it is deleted",
  },
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
});

export const deleteVolume: ToolDefinition = writeTool({
  name: 'delete_volume',
  description:
    `Delete a block storage volume. Requires scope services:write. id comes from list_volumes.`,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: "permanently deletes the volume and all data on it",
  },
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Volume id from list_volumes.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/volumes/${encodeSegment(a.id, 'id')}`,
});

export const attachVolume: ToolDefinition = writeTool({
  name: 'attach_volume',
  description:
    `Attach a block storage volume to a cloud VM. Requires scope services:write. id (the volume) comes ` +
    `from list_volumes; serverId is the cloud VM to attach to (the same value as the cloud VM service_id ` +
    `from list_services).`,
  method: 'POST',
  safety: { kind: 'plain' },
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Volume id from list_volumes.' },
      serverId: { type: 'string', minLength: 1, description: 'Cloud VM to attach to (the same value as the cloud VM service_id from list_services; must be in your project).' },
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
    `Detach a block storage volume from a cloud VM. Requires scope services:write. id (the volume) comes ` +
    `from list_volumes; serverId is the cloud VM to detach from (the same value as the cloud VM ` +
    `service_id from list_services).`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: "disconnects the volume from the VM; anything on the VM using it loses access to that data until it is attached again",
  },
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Volume id from list_volumes.' },
      serverId: { type: 'string', minLength: 1, description: 'Cloud VM to detach from (the same value as the cloud VM service_id from list_services).' },
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
    `Create a new private network (VPC); VPCs carry no separate charge. Requires scope services:write. ` +
    `name is the display name (1-253 chars); a /16 CIDR is auto-allocated. Move VMs into it afterward ` +
    `with attach_network_vm.`,
  method: 'POST',
  safety: { kind: 'plain' },
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
    `Delete a private network (VPC). Requires scope services:write. Refused server-side for the default ` +
    `VPC or one that still has VMs attached. id comes from list_networks.`,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: "permanently deletes the private network",
  },
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'VPC id from list_networks.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/networks/${encodeSegment(a.id, 'id')}`,
});

export const attachNetworkVm: ToolDefinition = writeTool({
  name: 'attach_network_vm',
  description:
    `Move a cloud VM into a private network (VPC), detaching it from its current VPC (the VM's public ` +
    `eth0 interface is untouched). Requires scope services:write. id is the target VPC from ` +
    `list_networks; serverId is the cloud VM to move (the same value as the cloud VM service_id from ` +
    `list_services).`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason:
      'moves the VM out of its current private network, cutting its existing private connections (the public interface is untouched)',
  },
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Target VPC (network) id from list_networks.' },
      serverId: { type: 'string', minLength: 1, description: 'Cloud VM to move into this VPC (the same value as the cloud VM service_id from list_services).' },
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
    `Reserve a new static public IP (EUR 2/mo, billed monthly until released). Requires scope ` +
    `services:write. Optionally pass serverId (the same value as the cloud VM service_id from ` +
    `list_services) to reserve AND attach it to that cloud VM in the same call. Manage it afterward with ` +
    `attach_reserved_ip / detach_reserved_ip / release_reserved_ip.`,
  method: 'POST',
  safety: {
    kind: 'spends',
    reason: "reserves a public IP billed EUR 2/month until it is released",
  },
  input: z.object({ serverId: z.string().min(1).optional() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      serverId: {
        type: 'string',
        minLength: 1,
        description: 'Optional cloud VM to attach the new IP to immediately (the same value as the cloud VM service_id from list_services).',
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
});

export const releaseReservedIp: ToolDefinition = writeTool({
  name: 'release_reserved_ip',
  description:
    `Release (permanently delete) a reserved public IP; billing for it stops. Requires scope ` +
    `services:write. id comes from list_reserved_ips.`,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: "gives the public IP back; the address is gone for good and cannot be recovered",
  },
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Reserved IP id from list_reserved_ips.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/reserved-ips/${encodeSegment(a.id, 'id')}`,
});

export const attachReservedIp: ToolDefinition = writeTool({
  name: 'attach_reserved_ip',
  description:
    `Attach a reserved (static) public IP to one of your cloud VMs. Requires scope services:write. id ` +
    `comes from list_reserved_ips; serverId is the cloud VM to attach to (the same value as the cloud VM ` +
    `service_id from list_services).`,
  method: 'POST',
  safety: { kind: 'plain' },
  input: z.object({ id: z.string().min(1), serverId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Reserved IP id from list_reserved_ips.' },
      serverId: { type: 'string', minLength: 1, description: 'Cloud VM to attach to (the same value as the cloud VM service_id from list_services; must be owned by you).' },
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
    `Detach a reserved public IP from its VM. The IP stays allocated and billed until you release it with ` +
    `release_reserved_ip. Requires scope services:write. id comes from list_reserved_ips.`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: "takes the public IP off the VM; traffic to that address stops reaching it until it is attached again",
  },
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Reserved IP id from list_reserved_ips.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/reserved-ips/${encodeSegment(a.id, 'id')}/detach`,
});
