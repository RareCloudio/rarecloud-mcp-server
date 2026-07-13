// Managed Kubernetes WRITE tools (Parity Phase B, Task 4). The mutating twin of
// the read-only k8s.ts: set cluster scale, add/edit/delete/rename node pools,
// enable the HA control plane, and manage the long-lived kubeconfig credential
// lifecycle (mint + revoke). All build on the shared `writeTool` factory so
// input validation, the confirm gate, per-segment path encoding, and the
// APIError -> errorResult mapping stay uniform. All scope services:write.
//
// Money-spend / irreversible-teardown tools carry `confirm: true`; the ones
// that tear something down (delete pool, revoke credential) also set
// destructiveHint. `service_id` (and any `pool` / `credential_id`) is always
// run through encodeSegment. Bodies + the `role`/`ttl` enums are re-confirmed
// against console openapi.json AND the route source (api/src/routes/
// v1-services.ts) — see the DEVIATION note on create_cluster_kubeconfig.

import { z } from 'zod';
import { type ToolDefinition, type ToolCallResult, textResult, errorResult } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

// The kubeconfigs endpoint returns { kubeconfig: "<YAML>", ... } (the client
// already unwraps the { ok, data } envelope). Emit the raw YAML as a plain-text
// block (kubectl-ready), not the JSON envelope. Re-declared here (not imported
// from k8s.ts) to keep the Phase A read file byte-untouched.
function kubeconfigResult(data: unknown): ToolCallResult {
  const yaml = (data as { kubeconfig?: unknown } | null | undefined)?.kubeconfig;
  return typeof yaml === 'string' && yaml.length > 0
    ? textResult(yaml)
    : errorResult('API returned no kubeconfig');
}

export const setClusterScale: ToolDefinition = writeTool({
  name: 'set_cluster_scale',
  description:
    'Set the autoscaling bounds (minimum/maximum worker count) of the FIRST node pool of a managed ' +
    'Kubernetes cluster. Requires scope services:write. minimum >= 1 and maximum >= minimum (enforced ' +
    'server-side). Adjusts an existing pool — it does not add one (use add_cluster_pool for that). ' +
    'service_id comes from list_services (a cloud-k8s service); read current sizing with get_cluster_scale.',
  method: 'POST',
  input: z
    .object({
      service_id: z.string().min(1),
      minimum: z.number().int().min(1),
      maximum: z.number().int(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
      minimum: { type: 'integer', minimum: 1, description: 'Minimum worker count for the first pool (>= 1).' },
      maximum: { type: 'integer', description: 'Maximum worker count (must be >= minimum).' },
    },
    required: ['service_id', 'minimum', 'maximum'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/scale`,
  buildBody: (a) => ({ minimum: a.minimum, maximum: a.maximum }),
});

export const addClusterPool: ToolDefinition = writeTool({
  name: 'add_cluster_pool',
  description:
    'Add a named worker node pool to a managed Kubernetes cluster. Requires scope services:write. ' +
    'SPENDS MONEY: a new pool provisions billable worker nodes. Pass confirm:true only after the user ' +
    'has approved the pool and its cost. name is the pool name (lowercase letters/digits/hyphens, start ' +
    'with a letter, max 15, unique in the cluster); minimum/maximum are the autoscaling bounds; ' +
    'machineType (worker flavor, resolved server-side) and volumeSizeGb (per-node root volume, 10-1000 ' +
    'GiB, default 30) are optional. service_id comes from list_services; inspect existing pools with ' +
    'list_cluster_pools.',
  method: 'POST',
  input: z
    .object({
      service_id: z.string().min(1),
      name: z.string().min(1),
      minimum: z.number().int(),
      maximum: z.number().int(),
      machineType: z.string().min(1).optional(),
      volumeSizeGb: z.number().int().min(10).max(1000).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
      name: { type: 'string', description: 'Node-pool name (lowercase letters/digits/hyphens, start with a letter, max 15; unique in the cluster).' },
      minimum: { type: 'integer', description: 'Minimum worker count (autoscaling lower bound).' },
      maximum: { type: 'integer', description: 'Maximum worker count (>= minimum, <= 16).' },
      machineType: { type: 'string', description: 'Worker machine type / flavor (resolved server-side). Defaults to the cluster default when omitted.' },
      volumeSizeGb: { type: 'integer', minimum: 10, maximum: 1000, description: 'Per-node root-volume size in GiB (default 30).' },
    },
    required: ['service_id', 'name', 'minimum', 'maximum'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/pools`,
  buildBody: (a) => {
    const body: Record<string, unknown> = { name: a.name, minimum: a.minimum, maximum: a.maximum };
    if (a.machineType !== undefined) body.machineType = a.machineType;
    if (a.volumeSizeGb !== undefined) body.volumeSizeGb = a.volumeSizeGb;
    return body;
  },
  confirm: true,
});

export const updateClusterPool: ToolDefinition = writeTool({
  name: 'update_cluster_pool',
  description:
    'Edit an existing worker node pool of a managed Kubernetes cluster — any of its autoscaling bounds ' +
    '(minimum/maximum), machineType, or per-node volumeSizeGb (10-1000 GiB). Requires scope ' +
    'services:write. Send only the fields you want to change; omitted fields are left as-is. Plain write ' +
    '— not gated. service_id from list_services; pool is the pool name from list_cluster_pools.',
  method: 'PATCH',
  input: z
    .object({
      service_id: z.string().min(1),
      pool: z.string().min(1),
      minimum: z.number().int().optional(),
      maximum: z.number().int().optional(),
      machineType: z.string().min(1).optional(),
      volumeSizeGb: z.number().int().min(10).max(1000).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
      pool: { type: 'string', description: 'Node-pool name from list_cluster_pools.' },
      minimum: { type: 'integer', description: 'New minimum worker count.' },
      maximum: { type: 'integer', description: 'New maximum worker count (>= minimum, <= 16).' },
      machineType: { type: 'string', description: 'New worker machine type / flavor (resolved server-side).' },
      volumeSizeGb: { type: 'integer', minimum: 10, maximum: 1000, description: 'New per-node root-volume size in GiB.' },
    },
    required: ['service_id', 'pool'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/pools/${encodeSegment(a.pool, 'pool')}`,
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.minimum !== undefined) body.minimum = a.minimum;
    if (a.maximum !== undefined) body.maximum = a.maximum;
    if (a.machineType !== undefined) body.machineType = a.machineType;
    if (a.volumeSizeGb !== undefined) body.volumeSizeGb = a.volumeSizeGb;
    return body;
  },
});

export const deleteClusterPool: ToolDefinition = writeTool({
  name: 'delete_cluster_pool',
  description:
    'Remove a worker node pool from a managed Kubernetes cluster. Requires scope services:write. ' +
    'DESTRUCTIVE: the pool and its worker nodes are drained and destroyed (the cluster must keep at ' +
    'least one pool — removing the last one is rejected). Pass confirm:true only after the user has ' +
    'explicitly approved. service_id from list_services; pool is the pool name from list_cluster_pools.',
  method: 'DELETE',
  input: z.object({ service_id: z.string().min(1), pool: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
      pool: { type: 'string', description: 'Node-pool name from list_cluster_pools.' },
    },
    required: ['service_id', 'pool'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/pools/${encodeSegment(a.pool, 'pool')}`,
  confirm: true,
  destructiveHint: true,
});

export const renameClusterPool: ToolDefinition = writeTool({
  name: 'rename_cluster_pool',
  description:
    'Rename a worker node pool of a managed Kubernetes cluster. Requires scope services:write. The ' +
    'rename adds a new pool and removes the old one, which rolls (replaces) the pool\'s worker nodes. ' +
    'name is the new pool name (lowercase letters/digits/hyphens, start with a letter, max 15). Plain ' +
    'write — not gated. service_id from list_services; pool is the current pool name from list_cluster_pools.',
  method: 'POST',
  input: z.object({ service_id: z.string().min(1), pool: z.string().min(1), name: z.string().min(1).max(64) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
      pool: { type: 'string', description: 'Current node-pool name from list_cluster_pools.' },
      name: { type: 'string', maxLength: 64, description: 'New node-pool name (lowercase letters/digits/hyphens, start with a letter, max 15).' },
    },
    required: ['service_id', 'pool', 'name'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/pools/${encodeSegment(a.pool, 'pool')}/rename`,
  buildBody: (a) => ({ name: a.name }),
});

export const enableClusterHa: ToolDefinition = writeTool({
  name: 'enable_cluster_ha',
  description:
    'Enable the HIGH-AVAILABILITY control plane on a managed Kubernetes cluster (multi-zone API server / ' +
    'etcd). Requires scope services:write. SPENDS MONEY: HA adds ~+EUR 30/mo to the cluster. ADD-ONLY and ' +
    'irreversible — Gardener does not allow turning HA back off; idempotent if the cluster is already HA. ' +
    'Pass confirm:true only after the user has approved the added cost. service_id from list_services.',
  method: 'POST',
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/high-availability`,
  confirm: true,
});

// DEVIATION FROM BRIEF (verified against console openapi.json AND the route
// source api/src/routes/v1-services.ts KubeconfigCreateBody — both AGREE and
// both DISAGREE with the brief exemplar): `ttl` is a 4-value ENUM
// ('30d' | '90d' | '1y' | 'never', server default '90d'), NOT the free-form
// string ('e.g. "720h"') the brief coded. Reality wins per the task's tie-break
// rule, so ttl is constrained to the enum here (a bogus "720h" is rejected
// client-side rather than round-tripping to a server 400). `name` is also
// capped at 64 (route .max(64) / openapi maxLength:64), tightening the brief's
// bare z.string().min(1).
export const createClusterKubeconfig: ToolDefinition = writeTool({
  name: 'create_cluster_kubeconfig',
  description:
    'Create a LONG-LIVED, revocable kubeconfig credential (a per-credential ServiceAccount) for a ' +
    'managed Kubernetes cluster, for standing automation (CI, GitOps). Requires scope services:write. ' +
    'role=admin (cluster-admin) or view (read-only); optional ttl is one of 30d, 90d, 1y, never (default ' +
    '90d; "never" mints a 10-year token). SECURITY: the result is a LIVE CREDENTIAL — a kubeconfig YAML ' +
    'embedding a bearer token. Treat it as a secret: do NOT echo it back or repeat its contents unless ' +
    'the user explicitly asks; pass it straight to the consuming tool. Returns the raw kubeconfig YAML as ' +
    'a text block. service_id comes from list_services (a cloud-k8s service). Revoke later with ' +
    'revoke_cluster_kubeconfig.',
  method: 'POST',
  input: z
    .object({
      service_id: z.string().min(1),
      name: z.string().min(1).max(64),
      role: z.enum(['admin', 'view']),
      ttl: z.enum(['30d', '90d', '1y', 'never']).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
      name: { type: 'string', maxLength: 64, description: 'Human label for the credential (shown in list_cluster_kubeconfigs).' },
      role: { type: 'string', enum: ['admin', 'view'], description: 'admin (cluster-admin) or view (read-only).' },
      ttl: { type: 'string', enum: ['30d', '90d', '1y', 'never'], description: 'Optional token lifetime; one of 30d, 90d, 1y, never. Omit for the default (90d).' },
    },
    required: ['service_id', 'name', 'role'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/kubeconfigs`,
  buildBody: (a) => ({ name: a.name, role: a.role, ...(a.ttl ? { ttl: a.ttl } : {}) }),
  formatResult: kubeconfigResult,
});

export const revokeClusterKubeconfig: ToolDefinition = writeTool({
  name: 'revoke_cluster_kubeconfig',
  description:
    'Revoke a LONG-LIVED kubeconfig credential of a managed Kubernetes cluster by its credential id — ' +
    'deletes the underlying ServiceAccount so the token stops working immediately. Requires scope ' +
    'services:write. DESTRUCTIVE and irreversible: any automation still using that credential breaks at ' +
    'once. Pass confirm:true only after the user has explicitly approved. service_id and credential_id ' +
    'both come from list_cluster_kubeconfigs.',
  method: 'DELETE',
  input: z.object({ service_id: z.string().min(1), credential_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services.' },
      credential_id: { type: 'string', description: 'Long-lived credential id from list_cluster_kubeconfigs.' },
    },
    required: ['service_id', 'credential_id'],
    additionalProperties: false,
  },
  buildPath: (a) =>
    `/v1/services/${encodeSegment(a.service_id, 'service_id')}/kubeconfigs/${encodeSegment(a.credential_id, 'credential_id')}`,
  confirm: true,
  destructiveHint: true,
});
