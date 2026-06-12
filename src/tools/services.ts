// Services tools — wrap /v1/services. Read-only for v1: list, get,
// list snapshots. No create/destroy/snapshot-create until we ship the
// derived-token + plan-and-approve flow described in
// docs/ideas/2026-05-22-agent-ai-architecture.md.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';

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
