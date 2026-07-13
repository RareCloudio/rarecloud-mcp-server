// Services tools — wrap /v1/services. Read-only for v1: list, get,
// list snapshots. No create/destroy/snapshot-create until we ship the
// derived-token + plan-and-approve flow described in
// docs/ideas/2026-05-22-agent-ai-architecture.md.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';
import { readTool } from './factories.js';

export const listServices: ToolDefinition = {
  name: 'list_services',
  description: 'List all services in the authenticated account: VPS servers, cloud VMs, proxies, hosting, domains. Returns each service\'s id, kind, name, status, IPv4, region, specs, billing cycle. Use to answer "what do I have running?" or to find a service ID for follow-up calls.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional filter by service category: "server" (legacy VPS), "cloud-vm", "cloud-k8s", "proxy", "hosting", "domain". Omit to return all.',
      },
    },
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      // The /v1/services route filters by `category` (not `kind`).
      const data = await client.get('/v1/services', {
        category: args.category as string | undefined,
      });
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getService: ToolDefinition = {
  name: 'get_service',
  description: 'Get full details for a single service by ID: status, network config, billing state, current-month usage. Use when you need more than the list_services summary (e.g. to inspect logs, current cost, attached resources).',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: {
        type: 'string',
        description: 'Service ID from list_services (e.g. "srv_01H8E9...").',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.service_id as string;
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getServiceMetrics: ToolDefinition = {
  name: 'get_service_metrics',
  description: 'Get resource metrics (CPU / RAM / disk / bandwidth time series) for a single service. Use to answer "is my server busy?" or "how much bandwidth have I used?".',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: {
        type: 'string',
        description: 'Service ID from list_services.',
      },
      period: {
        type: 'string',
        enum: ['hour', 'day', 'week', 'month'],
        description: 'Aggregation window (default: hour).',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.service_id as string;
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}/metrics`, {
        period: args.period as string | undefined,
      });
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const listBackups: ToolDefinition = {
  name: 'list_backups',
  description: 'List existing backups for a single legacy VPS server. Use to check whether a recent backup exists before a risky change, or to find a backup ID for restore.',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: {
        type: 'string',
        description: 'Server ID from list_services.',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.service_id as string;
      // /snapshots doesn't exist in v1; backups is the real read endpoint.
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}/backups`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getProvisioningState: ToolDefinition = {
  name: 'get_provisioning_state',
  description: 'Setup state of a pending service: whether its order is paid, whether the VM exists yet, and whether provisioning looks stuck (paid but unprovisioned past the grace period). Use after a deploy to watch it land, or to diagnose a service that stays pending.',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: {
        type: 'string',
        description: 'Service ID from list_services.',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.service_id as string;
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}/provisioning`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const listOsTemplates: ToolDefinition = {
  name: 'list_os_templates',
  description: 'Operating systems a legacy VPS can be reinstalled with (Virtualizor templates). Read-only; the reinstall itself is a destructive write and is not exposed as an MCP tool.',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: {
        type: 'string',
        description: 'Server ID from list_services.',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.service_id as string;
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}/os-templates`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const listUpgradeOptions: ToolDefinition = {
  name: 'list_upgrade_options',
  description: 'Plans (and billing cycles with prices) a service could be upgraded/downgraded to, from its product group. Read-only; the actual upgrade creates an invoice and is not exposed as an MCP tool.',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: {
        type: 'string',
        description: 'Service ID from list_services.',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.service_id as string;
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}/upgrade`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

// service_id-scoped detail reads. Each hits a fixed sub-path under the service.
const serviceIdSchema = {
  type: 'object' as const,
  properties: {
    service_id: { type: 'string', description: 'Service ID from list_services.' },
  },
  required: ['service_id'],
  additionalProperties: false,
};

export const getServiceIso = readTool({
  name: 'get_service_iso',
  description: 'Get the mounted-ISO status for a legacy VPS: whether a rescue/install ISO is currently attached and, if so, which one. Use to check a server\'s boot media before a reinstall or rescue. Read-only; mount/unmount are writes and are not exposed as MCP tools. The service_id comes from list_services.',
  inputSchema: serviceIdSchema,
  buildPath: (args) => `/v1/services/${encodeURIComponent(String(args.service_id))}/iso`,
});

export const listServiceSshKeyLibrary = readTool({
  name: 'list_service_ssh_key_library',
  description: 'List the SSH keys registered in a legacy VPS\'s key library (Virtualizor) — each with id, name, publicKey, and a server-computed fingerprint. These are the keys selectable when reinstalling this server. Distinct from list_ssh_keys, which returns the keys already installed on the running server. The service_id comes from list_services.',
  inputSchema: serviceIdSchema,
  buildPath: (args) => `/v1/services/${encodeURIComponent(String(args.service_id))}/ssh-keys/library`,
});

export const getServiceAutorenew = readTool({
  name: 'get_service_autorenew',
  description: 'Get whether a service auto-renews from account balance ({enabled}). Auto-renew defaults on: at the due date the renewal invoice is paid automatically from promo bonus first, then real credit — enabled:false is the per-service opt-out (bonus still applies). Use to confirm a service won\'t lapse, or explain an unexpected renewal charge. The service_id comes from list_services.',
  inputSchema: serviceIdSchema,
  buildPath: (args) => `/v1/services/${encodeURIComponent(String(args.service_id))}/autorenew`,
});

export const getVpanelStatus = readTool({
  name: 'get_vpanel_status',
  description: 'Check whether a legacy VPS\'s management panel (Virtualizor) is reachable — a reachability probe that distinguishes a node/infra outage (available:false, reason:node-unavailable) from a working panel, and reports reason:not-a-vps when the service has no Virtualizor VPS. Returns {vpsId, available, reason}. Use before pointing a user at the panel, or to tell "the node is down" apart from "the panel works". The service_id comes from list_services.',
  inputSchema: serviceIdSchema,
  buildPath: (args) => `/v1/services/${encodeURIComponent(String(args.service_id))}/vpanel/status`,
});
