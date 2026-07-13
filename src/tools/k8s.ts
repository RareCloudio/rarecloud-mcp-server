// Managed Kubernetes tools — wrap the cloud-k8s subset of /v1/services/{id}.
// Read-only for Parity Phase A: cluster scale, node pools, the short-lived
// admin kubeconfig, and the long-lived kubeconfig credentials (list +
// re-download). Creating/revoking long-lived credentials and setting scale
// are writes, deferred to Phase B.
//
// Two of these tools return a LIVE credential. The API delivers it inside a
// JSON envelope ({ kubeconfig: "<YAML>", ... }) — verified against
// openapi.json — so there's no raw text/plain transport to special-case on the
// client. These handlers unwrap `data.kubeconfig` and emit the YAML verbatim
// as a plain-text block (textResult), so the agent can hand it straight to
// kubectl instead of a JSON-wrapped object.

import { APIError } from '../client.js';
import { type ToolDefinition, textResult, errorResult } from './types.js';
import { readTool } from './factories.js';

// service_id-scoped detail reads that return JSON as-is.
const serviceIdSchema = {
  type: 'object' as const,
  properties: {
    service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services (a cloud-k8s service).' },
  },
  required: ['service_id'],
  additionalProperties: false,
};

export const getClusterScale = readTool({
  name: 'get_cluster_scale',
  description: 'Get the current scale of a managed Kubernetes cluster: its worker node pools plus any add-ons (autoscaler bounds, HA control plane, etc.). Use to answer "how big is my cluster right now?" or to read current sizing before planning a resize. Read-only; changing the scale is a write and is not exposed as an MCP tool. The service_id comes from list_services (a cloud-k8s service).',
  inputSchema: serviceIdSchema,
  buildPath: (args) => `/v1/services/${encodeURIComponent(String(args.service_id))}/scale`,
});

export const listClusterPools = readTool({
  name: 'list_cluster_pools',
  description: 'List the worker node pools of a managed Kubernetes cluster — each pool\'s name, machine type/flavor, node count, and autoscaling min/max. Use to inspect how the cluster\'s compute is organized before a scale change, or to find a pool by name. Read-only; adding/editing/removing pools are writes and are not exposed as MCP tools. The service_id comes from list_services (a cloud-k8s service).',
  inputSchema: serviceIdSchema,
  buildPath: (args) => `/v1/services/${encodeURIComponent(String(args.service_id))}/pools`,
});

export const listClusterKubeconfigs = readTool({
  name: 'list_cluster_kubeconfigs',
  description: 'List the LONG-LIVED kubeconfig credentials issued for a managed Kubernetes cluster — metadata only (id, name, role admin|view, createdAt, expiresAt, revokedAt, lastDownloadedAt, status active|expired|revoking|revoked). Each is a revocable, per-credential ServiceAccount meant for standing automation (CI, GitOps). The token itself is NEVER returned here — re-download an active one with download_cluster_kubeconfig. Use to see which credentials exist, which are still active, and to find a credential_id. The service_id comes from list_services (a cloud-k8s service).',
  inputSchema: serviceIdSchema,
  buildPath: (args) => `/v1/services/${encodeURIComponent(String(args.service_id))}/kubeconfigs`,
});

// --- Live-credential reads -------------------------------------------------
// Hand-written handlers: the endpoint returns JSON { kubeconfig, ... } but we
// want the raw YAML in a plain-text block, so we unwrap data.kubeconfig here
// instead of jsonResult-ing the whole envelope. Same APIError -> errorResult
// mapping as the factories.

interface KubeconfigPayload {
  kubeconfig?: unknown;
}

// Returns the kubeconfig YAML string, or null when the envelope has no usable
// `kubeconfig` field. Callers turn null into an errorResult rather than emitting
// an empty text block (a server-contract violation: an empty credential is
// worthless and must not read as success).
function kubeconfigYaml(data: unknown): string | null {
  const yaml = (data as KubeconfigPayload | null | undefined)?.kubeconfig;
  return typeof yaml === 'string' && yaml.length > 0 ? yaml : null;
}

export const getClusterKubeconfig: ToolDefinition = {
  name: 'get_cluster_kubeconfig',
  description:
    'Fetch a SHORT-LIVED admin kubeconfig for a managed Kubernetes cluster — a freshly-minted cluster-admin credential that expires within hours and leaves NO standing credential behind. Prefer this for one-off, interactive kubectl access. For standing automation that must keep working, use a long-lived credential instead (list_cluster_kubeconfigs + download_cluster_kubeconfig). SECURITY: the result is a LIVE CREDENTIAL — a kubeconfig YAML embedding a bearer token that grants cluster-admin. Treat it as a secret: do NOT echo it back to the user or repeat its contents unless the user explicitly asks to see it; pass it straight to the tool that consumes it. Returns the raw kubeconfig YAML as a text block. The service_id comes from list_services (a cloud-k8s service).',
  inputSchema: serviceIdSchema,
  async handler(client, args) {
    try {
      const id = String(args.service_id ?? '');
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}/kubeconfig`);
      const yaml = kubeconfigYaml(data);
      return yaml === null ? errorResult('API returned no kubeconfig') : textResult(yaml);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const downloadClusterKubeconfig: ToolDefinition = {
  name: 'download_cluster_kubeconfig',
  description:
    'Re-download a LONG-LIVED kubeconfig credential for a managed Kubernetes cluster by its credential id — a revocable, per-credential ServiceAccount kubeconfig for standing automation that must keep working (unlike the short-lived admin config from get_cluster_kubeconfig). Works for ACTIVE credentials only; revoked or expired credentials return an error. SECURITY: the result is a LIVE CREDENTIAL — a kubeconfig YAML embedding a bearer token. Treat it as a secret: do NOT echo it back to the user or repeat its contents unless the user explicitly asks to see it; pass it straight to the tool that consumes it. Returns the raw kubeconfig YAML as a text block. service_id and credential_id both come from list_cluster_kubeconfigs.',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Managed-Kubernetes service ID from list_services (a cloud-k8s service).' },
      credential_id: { type: 'string', description: 'Long-lived credential id from list_cluster_kubeconfigs (an active credential).' },
    },
    required: ['service_id', 'credential_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = String(args.service_id ?? '');
      const credId = String(args.credential_id ?? '');
      const data = await client.get(
        `/v1/services/${encodeURIComponent(id)}/kubeconfigs/${encodeURIComponent(credId)}/download`,
      );
      const yaml = kubeconfigYaml(data);
      return yaml === null ? errorResult('API returned no kubeconfig') : textResult(yaml);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};
