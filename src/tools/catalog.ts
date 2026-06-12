// Catalog tools — un-authed endpoints, useful for "what can we deploy?"
// queries. Token is still passed so we use the same client; the API
// ignores it on these routes.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';

export const listCatalogProducts: ToolDefinition = {
  name: 'list_catalog_products',
  description: 'List orderable products from the RareCloud catalog. Use to answer "what plans can I deploy?" Returns SKU, kind (legacy_vps / cloud_compute / proxy / ...), category, display name. Filter by kind or backend to narrow results.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['legacy_vps', 'cloud_compute', 'cloud_k8s', 'cloud_volume', 'cloud_network', 'dedicated_server', 'proxy', 'hosting', 'domain', 'app_hosting'],
        description: 'Filter by product kind. Most users want legacy_vps (KVM VPS) or cloud_compute (hourly OpenStack VMs).',
      },
      backend: {
        type: 'string',
        enum: ['whmcs', 'virtualizor', 'openstack', 'gardener'],
        description: 'Filter by underlying backend. Usually you do NOT need this — pick by kind instead.',
      },
      category: {
        type: 'string',
        description: 'Filter by category name (e.g. "KVM Servers", "Proxies").',
      },
    },
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const data = await client.get('/v1/catalog/products', {
        kind: args.kind as string | undefined,
        backend: args.backend as string | undefined,
        category: args.category as string | undefined,
      });
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getCatalogPlan: ToolDefinition = {
  name: 'get_catalog_plan',
  description: 'Get full details for a single catalog product including all plans (sizes), their specs (vCPU, RAM, disk, bandwidth), pricing for every supported billing cycle, and supported billing tracks. Use before generating a Terraform plan or before recommending a specific SKU.',
  inputSchema: {
    type: 'object',
    properties: {
      sku: {
        type: 'string',
        description: 'Product SKU from list_catalog_products (e.g. "whmcs.kvm-servers-plus-vps").',
      },
    },
    required: ['sku'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const sku = args.sku as string;
      const data = await client.get(`/v1/catalog/products/${encodeURIComponent(sku)}`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const listRegions: ToolDefinition = {
  name: 'list_regions',
  description: 'List available RareCloud datacenter regions. Each region has a slug (e.g. "frankfurt-de"), display name, country code, and which backends can provision there.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(client) {
    try {
      const data = await client.get('/v1/catalog/regions');
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const listImages: ToolDefinition = {
  name: 'list_images',
  description: 'List available OS images (Ubuntu / Debian / Rocky / Windows Server / etc) that can be installed on new servers. Use to validate an image slug before recommending it.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(client) {
    try {
      const data = await client.get('/v1/catalog/images');
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};
