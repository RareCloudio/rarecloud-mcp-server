// Catalog tools — un-authed endpoints, useful for "what can we deploy?"
// queries. Token is still passed so we use the same client; the API
// ignores it on these routes.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';
import { readList, readTool, encodeSegment } from './factories.js';

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
      const sku = encodeSegment(args.sku, 'sku');
      const data = await client.get(`/v1/catalog/products/${sku}`);
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

export const getProductDetails = readTool({
  name: 'get_product_details',
  description: 'Get the live, order-ready detail for one product SKU: every billing cycle with its price, the plans (sizes) on offer, and the config options (e.g. the OS-template field) a purchase must fill in. Richer than get_catalog_plan — use this right before building an order or quoting a price. The sku comes from list_catalog_products or a list_catalog_listings card.',
  inputSchema: {
    type: 'object',
    properties: {
      sku: { type: 'string', description: 'Product SKU from list_catalog_products / list_catalog_listings (e.g. "whmcs.kvm-servers-plus-vps").' },
    },
    required: ['sku'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/catalog/products/${encodeSegment(args.sku, 'sku')}/details`,
});

export const listPrepurchaseOsTemplates = readTool({
  name: 'list_prepurchase_os_templates',
  description: 'List the OS templates selectable at purchase time for a legacy VPS / dedicated-server SKU — each with slug, display name, and version. Use to pick a valid OS before ordering one of these products. (For the OS list of an already-running server use list_os_templates with a service_id instead.) The sku comes from list_catalog_products.',
  inputSchema: {
    type: 'object',
    properties: {
      sku: { type: 'string', description: 'Legacy/dedicated product SKU from list_catalog_products.' },
    },
    required: ['sku'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/catalog/products/${encodeSegment(args.sku, 'sku')}/os-templates`,
});

export const listCatalogListings = readTool({
  name: 'list_catalog_listings',
  description: 'List the deploy-wizard product cards for one category — the same tiles the console shows on the "create" screen, each with sku, display name, tier, pricing, specs, and available regions. Use to browse "what can I deploy in this category?" and to grab a sku to pass on to get_product_details.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['cloud-vm', 'cloud-k8s', 'cloud-volume', 'cloud-network', 'cloud-loadbalancer', 'cloud-reserved-ip', 'server', 'hosting', 'proxy', 'domain'],
        description: 'Which deploy-wizard category to list cards for.',
      },
    },
    required: ['category'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/catalog/listings/${encodeSegment(args.category, 'category')}`,
});

export const listKubernetesVersions = readList(
  'list_kubernetes_versions',
  '/v1/catalog/kubernetes-versions',
  'List the managed-Kubernetes (Gardener shoot) versions currently offered, newest-supported first. Use to pick or validate a version before deploying a cloud-k8s cluster.',
);
