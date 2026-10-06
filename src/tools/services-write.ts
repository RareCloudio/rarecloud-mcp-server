// Service write/action tools (Parity Phase B). The first mutating surface on
// this MCP server: everything here builds on the shared `writeTool` factory so
// input validation, the confirm gate, path encoding, and APIError handling stay
// uniform. More service-write tools land here in Tasks 2 & 3.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

export const setServiceHostname: ToolDefinition = writeTool({
  name: 'set_service_hostname',
  description:
    `Rename a service. For a legacy VPS this sets its hostname. For a cloud VM it renames the server (the ` +
    `name shown in the console and the API); the hostname inside the running operating system is not ` +
    `changed. Requires scope services:write. service_id comes from list_services (a legacy VPS id or a ` +
    `cloud VM id); hostname is a valid DNS hostname (1-253 chars).`,
  method: 'POST',
  safety: { kind: 'plain' },
  input: z
    .object({
      service_id: z.string().min(1),
      hostname: z.string().min(1).max(253),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      hostname: { type: 'string', description: 'New hostname (valid DNS name, 1–253 chars).' },
    },
    required: ['service_id', 'hostname'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/hostname`,
  buildBody: (a) => ({ hostname: a.hostname }),
});

// ---------------------------------------------------------------------------
// Task 2: deploy + lifecycle + money-spend writes.
//
// Each tool's `safety` kind drives its confirm gate and annotations (see
// writeTool in factories.ts). `service_id` (from list_services) is always run
// through encodeSegment. Bodies are re-confirmed against console openapi.json.
// ---------------------------------------------------------------------------

const DEPLOY_CATEGORY = [
  'server', 'hosting', 'proxy', 'domain',
  'cloud-vm', 'cloud-k8s', 'cloud-volume', 'cloud-loadbalancer', 'cloud-network',
] as const;
const BILLING_CYCLE = [
  'monthly', 'quarterly', 'semiannually', 'annually', 'biennially', 'triennially', 'hourly',
] as const;

// deploy_service is polymorphic: `category` selects the product family and the
// relevant fields vary per family. The API infers `category` from the SKU and
// validates per-family, so we forward the whole validated body. The
// productId||plan requirement is enforced via a zod .refine on the input
// schema below — writeTool's factory generic is `S extends z.ZodTypeAny`, so
// the resulting ZodEffects (which .refine produces, not a plain ZodObject)
// still flows through `opts.input.safeParse` unchanged.
export const deployService: ToolDefinition = writeTool({
  name: 'deploy_service',
  description:
    `Deploy (order + provision) a new service. Requires scope services:write. Polymorphic: \`category\` ` +
    `selects the product family (cloud-vm | cloud-k8s | cloud-volume | cloud-loadbalancer | cloud-network ` +
    `| server | hosting | proxy | domain); category may be omitted and is then inferred from the catalog ` +
    `product. \`productId\` (alias \`plan\`) is the catalog SKU from list_catalog_products / ` +
    `list_catalog_listings; the other fields depend on the family: discover them with ` +
    `get_product_details, list_catalog_listings, list_kubernetes_versions, list_regions, list_images. ` +
    `Preview the plan and its cost with get_product_details before asking the user to approve. For a ` +
    `cloud VM deployed without rootPassword, the result includes a one-time consolePassword.`,
  method: 'POST',
  safety: {
    kind: 'spends',
    reason: "places a real order and provisions billable infrastructure, charged to the account",
  },
  returnsSecret: "the new server's console/root password",
  input: z
    .object({
      category: z.enum(DEPLOY_CATEGORY).optional(),
      productId: z.string().min(1).optional(),
      plan: z.string().min(1).optional(),
      region: z.string().optional(),
      billingCycle: z.enum(BILLING_CYCLE).optional(),
      hostname: z.string().optional(),
      name: z.string().optional(),
      imageId: z.string().optional(),
      image: z.string().optional(),
      sshKeyId: z.string().optional(),
      sshKey: z.string().optional(),
      sshPublicKey: z.string().optional(),
      rootPassword: z.string().optional(),
      k8sVersion: z.string().optional(),
      machineType: z.string().optional(),
      workerMin: z.number().int().optional(),
      workerMax: z.number().int().optional(),
      pools: z.array(z.record(z.unknown())).optional(),
      port: z.number().int().optional(),
      memberServerIds: z.array(z.string()).optional(),
      healthCheck: z.boolean().optional(),
      sizeGb: z.number().int().optional(),
      addons: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      vpcId: z.string().optional(),
      configOptions: z.record(z.unknown()).optional(),
      customFields: z.record(z.unknown()).optional(),
      payWith: z.string().optional(),
    })
    .strict()
    .refine((v) => Boolean(v.productId || v.plan), {
      message: 'productId (or its alias plan) is required',
    }),
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: [...DEPLOY_CATEGORY], description: 'Product family; inferred from the SKU if omitted.' },
      productId: { type: 'string', description: 'Catalog SKU / backend product id from list_catalog_products or list_catalog_listings.' },
      plan: { type: 'string', description: 'Alias for productId.' },
      region: { type: 'string', description: 'Region code (see list_regions).' },
      billingCycle: { type: 'string', enum: [...BILLING_CYCLE] },
      hostname: { type: 'string' }, name: { type: 'string', description: 'Alias for hostname.' },
      imageId: { type: 'string', description: 'OS image id or slug from list_images (or list_prepurchase_os_templates for a VPS SKU).' },
      image: { type: 'string', description: 'Alias for imageId.' },
      sshKeyId: { type: 'string', description: 'Account SSH key id or name from list_account_ssh_keys.' },
      sshKey: { type: 'string', description: 'Alias for sshKeyId.' },
      sshPublicKey: { type: 'string', description: 'cloud-vm: raw public key injected via cloud-init.' },
      rootPassword: { type: 'string', description: 'Root password for the new server; a secret, never echoed or logged.' },
      k8sVersion: { type: 'string', description: 'cloud-k8s: version from list_kubernetes_versions.' },
      machineType: { type: 'string' },
      workerMin: { type: 'integer' }, workerMax: { type: 'integer' },
      pools: { type: 'array', items: { type: 'object' } },
      port: { type: 'integer' },
      memberServerIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'cloud-loadbalancer: cloud VMs to balance across (each the same value as the cloud VM service_id from list_services).',
      },
      healthCheck: { type: 'boolean' }, sizeGb: { type: 'integer' },
      addons: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } },
      vpcId: { type: 'string', description: 'cloud-vm: private network id from list_networks.' },
      configOptions: { type: 'object' }, customFields: { type: 'object' },
      payWith: { type: 'string' },
    },
    required: [],
    additionalProperties: false,
  },
  buildPath: () => '/v1/services',
  buildBody: (a) => a, // whole validated body; the API infers category + validates per-family
});

export const destroyService: ToolDefinition = writeTool({
  name: 'destroy_service',
  description:
    `Permanently destroy a service and release its resources. Requires scope services:write. service_id ` +
    `comes from list_services.`,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: "permanently deletes the service and all of its data",
  },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { type: 'string', description: 'Service ID from list_services.' } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}`,
});

export const resizeService: ToolDefinition = writeTool({
  name: 'resize_service',
  description:
    `Resize a cloud VM service to a new flavor (target plan PUBLIC SKU, e.g. c-4vcpu-8gb, from ` +
    `list_catalog_products). Requires scope services:write. Runs asynchronously ` +
    `(returns 202). service_id comes from list_services.`,
  method: 'POST',
  safety: {
    kind: 'spends',
    reason: "moves the VM to a different plan, which changes what the service costs from then on",
  },
  input: z.object({ service_id: z.string().min(1), flavor: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      flavor: { type: 'string', description: 'Target plan public SKU from list_catalog_products (e.g. c-4vcpu-8gb).' },
    },
    required: ['service_id', 'flavor'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/resize`,
  buildBody: (a) => ({ flavor: a.flavor }),
});

export const upgradeService: ToolDefinition = writeTool({
  name: 'upgrade_service',
  description:
    `Create an upgrade order moving a service to a new product/plan. Requires scope services:write. ` +
    `Preview the options and prices with list_upgrade_options. service_id comes from list_services; ` +
    `newProductId comes from list_upgrade_options.`,
  method: 'POST',
  safety: {
    kind: 'spends',
    reason: "places a real upgrade order and bills the price difference",
  },
  input: z
    .object({
      service_id: z.string().min(1),
      newProductId: z.string().min(1).max(64),
      cycle: z.enum(BILLING_CYCLE),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      newProductId: { type: 'string', maxLength: 64, description: 'Target product id (see list_upgrade_options).' },
      cycle: { type: 'string', enum: [...BILLING_CYCLE], description: 'Billing cycle for the upgraded product (e.g. monthly, annually).' },
    },
    required: ['service_id', 'newProductId', 'cycle'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/upgrade`,
  // Forward the API's own quote-vs-order flag confirm:true — the MCP confirm
  // gate has already passed by the time buildBody runs.
  buildBody: (a) => ({ newProductId: a.newProductId, cycle: a.cycle, confirm: true }),
});

export const renewService: ToolDefinition = writeTool({
  name: 'renew_service',
  description:
    `Ensure a renewal invoice exists for a service (renew the current term). Requires scope ` +
    `services:write. service_id comes from list_services.`,
  method: 'POST',
  safety: {
    kind: 'spends',
    reason: "generates a renewal invoice for the service and settles it from the account balance",
  },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { type: 'string', description: 'Service ID from list_services.' } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/renew`,
});

export const cancelService: ToolDefinition = writeTool({
  name: 'cancel_service',
  description:
    `File a cancellation request for a service. Requires scope services:write. type "immediate" stops it ` +
    `now; "end_of_term" (the server default) cancels at the paid-through date. service_id comes from ` +
    `list_services.`,
  method: 'POST',
  safety: {
    kind: 'destructive',
    reason: "schedules the service for termination (now, or at the end of the paid term); once it is terminated the service and its data are gone",
  },
  input: z
    .object({
      service_id: z.string().min(1),
      // openapi enum values are end_of_term / immediate (underscore), authoritative.
      type: z.enum(['immediate', 'end_of_term']).optional(),
      reason: z.string().max(1000).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      type: { type: 'string', enum: ['immediate', 'end_of_term'], description: 'Cancellation timing (default end_of_term server-side).' },
      reason: { type: 'string', maxLength: 1000, description: 'Optional free-text reason for cancelling.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/cancel`,
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.type !== undefined) body.type = a.type;
    if (a.reason !== undefined) body.reason = a.reason;
    return body;
  },
});

export const setServiceAutorenew: ToolDefinition = writeTool({
  name: 'set_service_autorenew',
  description:
    `Toggle auto-renew (renew automatically from account balance) for a service. Requires scope ` +
    `services:write. Nothing is charged now; a later automatic renewal is billed on its own schedule. ` +
    `service_id comes from list_services; read the current setting with get_service_autorenew.`,
  method: 'PUT',
  safety: { kind: 'plain' },
  input: z.object({ service_id: z.string().min(1), enabled: z.boolean() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      enabled: { type: 'boolean', description: 'true to enable auto-renew, false to disable.' },
    },
    required: ['service_id', 'enabled'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/autorenew`,
  buildBody: (a) => ({ enabled: a.enabled }),
});

export const createServiceBackup: ToolDefinition = writeTool({
  name: 'create_service_backup',
  description:
    `Create an on-demand backup of a legacy VPS service. Requires scope services:write. service_id comes ` +
    `from list_services (a legacy VPS); see existing backups with list_backups.`,
  method: 'POST',
  safety: { kind: 'plain' },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { type: 'string', description: 'Service ID from list_services.' } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/backups`,
});

export const mountServiceIso: ToolDefinition = writeTool({
  name: 'mount_service_iso',
  description:
    `Mount a rescue/install ISO on a VPS as a virtual CD-ROM. Requires scope services:write. The iso_url ` +
    `is fetched server-side (SSRF-guarded against private/metadata targets). service_id comes from ` +
    `list_services.`,
  method: 'PUT',
  safety: { kind: 'plain' },
  input: z.object({ service_id: z.string().min(1), iso_url: z.string().min(1).max(2048) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      iso_url: { type: 'string', maxLength: 2048, description: 'URL of the ISO to mount as a virtual CD-ROM.' },
    },
    required: ['service_id', 'iso_url'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/iso`,
  buildBody: (a) => ({ iso_url: a.iso_url }),
});

export const unmountServiceIso: ToolDefinition = writeTool({
  name: 'unmount_service_iso',
  description:
    `Unmount the currently mounted ISO from a VPS. Requires scope services:write. service_id comes from ` +
    `list_services; see the current mount with get_service_iso.`,
  method: 'DELETE',
  safety: { kind: 'plain' },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { type: 'string', description: 'Service ID from list_services.' } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/iso`,
});

export const setServicePassword: ToolDefinition = writeTool({
  name: 'set_service_password',
  description:
    `Set the root/administrator password of a legacy VPS service. Requires scope services:write. For a ` +
    `cloud VM use reset_service_password. service_id comes from list_services.`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: "replaces the server's root password (the guest may reboot); anyone using the old password is locked out",
  },
  acceptsSecret: "the password",
  input: z.object({ service_id: z.string().min(1), password: z.string().min(8).max(128) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      password: { type: 'string', minLength: 8, maxLength: 128, description: 'New root/admin password (8–128 chars). Never echoed or logged.' },
    },
    required: ['service_id', 'password'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/password`,
  buildBody: (a) => ({ password: a.password }),
});

// ---------------------------------------------------------------------------
// Task 3 — service actions (start/stop/reboot/reinstall/reset-password) +
// ssh-keys (8 tools).
//
// The 3 power actions POST /v1/services/{service_id}/actions/<literal> with NO
// body. reinstall/reset-password hit the SAME /actions/{action} endpoint but,
// per the live contract (console openapi.json + api/src/routes/v1-services.ts
// — verified together, both agree and both diverge from an earlier draft of
// this task's spec that assumed a bare no-body call):
//   - reinstall requires `imageId` in the body for BOTH a cloud VM (Nova UUID
//     service_id) and a legacy VPS (numeric service_id) — an empty body always
//     400s on the live endpoint. It is NOT legacy-only: the route's UUID_RE
//     branch calls cloudServices.reinstallCloudVm for a cloud VM id.
//   - reset-password requires a caller-chosen `password` (min 8 chars) — it
//     does not auto-generate one — and is CLOUD-VM-ONLY; a legacy numeric id
//     is rejected server-side with INVALID_PARAM. set_service_password's own
//     endpoint (/services/{id}/password) is the legacy-VPS twin.
// ---------------------------------------------------------------------------

export const startService: ToolDefinition = writeTool({
  name: 'start_service',
  description:
    `Power on a service (cloud VM or legacy VPS). Requires scope services:write. service_id comes from ` +
    `list_services.`,
  method: 'POST',
  safety: { kind: 'plain' },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { type: 'string', description: 'Service ID from list_services.' } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/actions/start`,
});

export const stopService: ToolDefinition = writeTool({
  name: 'stop_service',
  description:
    `Power off a service (cloud VM or legacy VPS). Requires scope services:write. service_id comes from ` +
    `list_services. Power it back on with start_service.`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: "powers the server off; everything running on it stops until it is started again",
  },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { type: 'string', description: 'Service ID from list_services.' } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/actions/stop`,
});

export const rebootService: ToolDefinition = writeTool({
  name: 'reboot_service',
  description:
    `Reboot a service (cloud VM or legacy VPS). Requires scope services:write. service_id comes from ` +
    `list_services.`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: "restarts the server; everything running on it is interrupted until it is back up",
  },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { type: 'string', description: 'Service ID from list_services.' } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/actions/reboot`,
});

export const reinstallService: ToolDefinition = writeTool({
  name: 'reinstall_service',
  description:
    `Reinstall (rebuild from scratch) a service; works on BOTH a cloud VM (UUID service_id) and a legacy ` +
    `VPS (numeric service_id). Requires scope services:write. The service keeps its IP. Requires imageId, ` +
    `an OS template/image slug from list_os_templates (for this service) or list_images. password and ` +
    `sshPublicKey are optional (sshPublicKey only applies to a cloud VM). For a cloud VM reinstalled ` +
    `without a password, the result includes a one-time consolePassword. service_id comes from ` +
    `list_services.`,
  method: 'POST',
  safety: {
    kind: 'destructive',
    reason: "wipes the server's disk and reinstalls the operating system; all data on it is lost",
  },
  returnsSecret: "the one-time consolePassword root password (cloud VM, when no password was supplied)",
  input: z
    .object({
      service_id: z.string().min(1),
      imageId: z.string().min(1).max(128),
      password: z.string().min(8).max(128).optional(),
      sshPublicKey: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      imageId: { type: 'string', maxLength: 128, description: 'OS template/image slug (see list_os_templates or list_images).' },
      password: { type: 'string', minLength: 8, maxLength: 128, description: 'Optional root password for the rebuilt server (8–128 chars). Never echoed or logged.' },
      sshPublicKey: { type: 'string', maxLength: 4096, description: 'Optional inline SSH public key to install for root (cloud VM only).' },
    },
    required: ['service_id', 'imageId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/actions/reinstall`,
  buildBody: (a) => {
    const body: Record<string, unknown> = { imageId: a.imageId };
    if (a.password !== undefined) body.password = a.password;
    if (a.sshPublicKey !== undefined) body.sshPublicKey = a.sshPublicKey;
    return body;
  },
});

export const resetServicePassword: ToolDefinition = writeTool({
  name: 'reset_service_password',
  description:
    `Reset the root password on a RUNNING cloud VM (UUID service_id) live via qemu-guest-agent; the VM ` +
    `keeps running and keeps its data (this is NOT a reboot or rebuild). Requires scope services:write. ` +
    `CLOUD VM ONLY: a legacy VPS (numeric service_id) is rejected; use set_service_password for that. You ` +
    `supply the new password (8-128 chars); the response does not return it. service_id comes from ` +
    `list_services.`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: "replaces the root password on the running VM; the old password stops working immediately",
  },
  acceptsSecret: "the new password",
  input: z.object({ service_id: z.string().min(1), password: z.string().min(8).max(128) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services (cloud VM / Nova UUID only).' },
      password: { type: 'string', minLength: 8, maxLength: 128, description: 'New root password (8–128 chars). Never echoed or logged.' },
    },
    required: ['service_id', 'password'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/actions/reset-password`,
  buildBody: (a) => ({ password: a.password }),
});

export const addServiceSshKey: ToolDefinition = writeTool({
  name: 'add_service_ssh_key',
  description:
    `Install an SSH public key directly onto a running service (per-server), distinct from ` +
    `add_service_ssh_key_to_library, which registers a key in the server's reinstall-time key library. ` +
    `Requires scope services:write. service_id comes from list_services.`,
  method: 'POST',
  safety: {
    kind: 'sensitive',
    reason: "grants SSH access to the running server to whoever holds the matching private key",
  },
  input: z
    .object({
      service_id: z.string().min(1),
      public_key: z.string().min(1).max(4096),
      name: z.string().max(200).optional(),
      id: z.string().max(64).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      public_key: { type: 'string', maxLength: 4096, description: 'The SSH public key material to install.' },
      name: { type: 'string', maxLength: 200, description: 'Optional label for the key.' },
      id: { type: 'string', maxLength: 64, description: 'Optional caller-supplied key id.' },
    },
    required: ['service_id', 'public_key'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/ssh-keys`,
  buildBody: (a) => {
    const body: Record<string, unknown> = { public_key: a.public_key };
    if (a.name !== undefined) body.name = a.name;
    if (a.id !== undefined) body.id = a.id;
    return body;
  },
});

export const addServiceSshKeyToLibrary: ToolDefinition = writeTool({
  name: 'add_service_ssh_key_to_library',
  description:
    `Register a new SSH key in a legacy VPS's key library (Virtualizor): the set of keys selectable when ` +
    `reinstalling this server (see list_service_ssh_key_library). It does not touch the keys authorized ` +
    `on the running server (add_service_ssh_key does that). Requires scope services:write. service_id ` +
    `comes from list_services.`,
  method: 'POST',
  safety: { kind: 'plain' },
  input: z.object({ service_id: z.string().min(1), name: z.string().min(1).max(200), key: z.string().min(1).max(4096) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      name: { type: 'string', maxLength: 200, description: 'A label for the key.' },
      key: { type: 'string', maxLength: 4096, description: 'The SSH public key material.' },
    },
    required: ['service_id', 'name', 'key'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/ssh-keys/library`,
  buildBody: (a) => ({ name: a.name, key: a.key }),
});

export const applyServiceSshKeyLibrary: ToolDefinition = writeTool({
  name: 'apply_service_ssh_key_library',
  description:
    `Apply a SET of library SSH keys to a legacy VPS, replacing whichever keys are currently authorized ` +
    `on the server. Requires scope services:write. Omit keyIds (or pass an empty array) to apply an empty ` +
    `set. service_id comes from list_services; keyIds come from list_service_ssh_key_library.`,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: "replaces the set of SSH keys authorized on the server; keys not in the list lose access (an empty list removes them all)",
  },
  input: z.object({ service_id: z.string().min(1), keyIds: z.array(z.string().min(1).max(64)).max(50).optional() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      keyIds: {
        type: 'array',
        items: { type: 'string', maxLength: 64 },
        maxItems: 50,
        description: 'Library key ids to apply (see list_service_ssh_key_library). Omit for an empty set.',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/ssh-keys/library/apply`,
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.keyIds !== undefined) body.keyIds = a.keyIds;
    return body;
  },
});
