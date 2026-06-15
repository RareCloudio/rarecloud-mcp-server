// Cloud infrastructure tools — read-only views of the resources Catalin's v1
// added alongside compute: volumes, private networks, load balancers,
// reserved IPs, and domains. Read-only by design (same as the rest of this
// server); mutations go through the REST API with a scoped write token.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';

function readList(name: string, path: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(client) {
      try {
        return jsonResult(await client.get(path));
      } catch (e) {
        return errorResult(e instanceof APIError ? e.message : (e as Error).message);
      }
    },
  };
}

function readOne(name: string, prefix: string, description: string, idKey = 'id'): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { [idKey]: { type: 'string', description: 'Resource id from the matching list_* tool.' } },
      required: [idKey],
      additionalProperties: false,
    },
    async handler(client, args) {
      try {
        const id = String(args[idKey] ?? '');
        return jsonResult(await client.get(`${prefix}/${encodeURIComponent(id)}`));
      } catch (e) {
        return errorResult(e instanceof APIError ? e.message : (e as Error).message);
      }
    },
  };
}

export const listVolumes = readList(
  'list_volumes',
  '/v1/volumes',
  'List block storage volumes in the account: id, name, size, status, which VM it is attached to, region. Use for "what storage do I have?" or to find a volume id.',
);

export const listNetworks = readList(
  'list_networks',
  '/v1/networks',
  'List private networks (VPCs): id, name, CIDR, status, attached VM count, whether it is the default. Use to map the account\'s network topology.',
);

export const listLoadBalancers = readList(
  'list_load_balancers',
  '/v1/load-balancers',
  'List L4 load balancers: id, name, status, public IP, listener port, member count. Use for "what load balancers exist?".',
);

export const getLoadBalancer = readOne(
  'get_load_balancer',
  '/v1/load-balancers',
  'Get one load balancer with its members (backend VMs and ports). Use after list_load_balancers to inspect membership.',
);

export const listReservedIps = readList(
  'list_reserved_ips',
  '/v1/reserved-ips',
  'List reserved (static) public IPs: id, address, status, which VM it is attached to. Use to see floating IPs and what they point at.',
);

export const listDomains = readList(
  'list_domains',
  '/v1/domains',
  'List registered domains: id, name, status, expiry, auto-renew. Use for "what domains do I own?" or to find a domain id.',
);

export const getDomain = readOne(
  'get_domain',
  '/v1/domains',
  'Get one domain: nameservers, transfer lock, WHOIS privacy, auto-renew, expiry. Use after list_domains for management detail.',
);
