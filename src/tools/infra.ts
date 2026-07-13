// Cloud infrastructure tools — read-only views of the cloud infrastructure
// resources: block volumes, private networks, load balancers, reserved IPs,
// and firewalls (security groups). Read-only by design (same as the rest of
// this server); mutations go through the REST API with a scoped write token.
// (Domains live in their own module, domains.ts.)

import { readList, readOne, readTool } from './factories.js';

export const listVolumes = readList(
  'list_volumes',
  '/v1/volumes',
  'List block storage volumes in the account: id, name, size, status, which VM it is attached to, region. Use for "what storage do I have?" or to find a volume id.',
);

export const getVolume = readOne(
  'get_volume',
  '/v1/volumes',
  'Get one block storage volume: id, name, size, status, region, and which VM it is attached to. Use after list_volumes to inspect a single volume.',
);

export const listNetworks = readList(
  'list_networks',
  '/v1/networks',
  'List private networks (VPCs): id, name, CIDR, status, attached VM count, whether it is the default. Use to map the account\'s network topology.',
);

export const getNetwork = readOne(
  'get_network',
  '/v1/networks',
  'Get one private network (VPC): id, name, CIDR, status, whether it is the default, and its attached VMs. Use after list_networks to inspect a single network.',
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

export const listLoadBalancerMembers = readTool({
  name: 'list_load_balancer_members',
  description:
    'List the backend members of a load balancer — each member VM\'s private fixed IP and its port in the pool. Use after list_load_balancers to inspect exactly which VMs sit behind a load balancer. The id comes from list_load_balancers.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Load balancer id from list_load_balancers.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/load-balancers/${encodeURIComponent(String(args.id))}/members`,
});

export const listReservedIps = readList(
  'list_reserved_ips',
  '/v1/reserved-ips',
  'List reserved (static) public IPs: id, address, status, which VM it is attached to. Use to see floating IPs and what they point at.',
);

export const listFirewalls = readList(
  'list_firewalls',
  '/v1/firewalls',
  'List cloud firewalls (security groups): id, name, status, attached VM count, rule count. Use for "what firewalls do I have?" or to find a firewall id.',
);

export const getFirewall = readOne(
  'get_firewall',
  '/v1/firewalls',
  'Get one firewall (security group) including its full inbound/outbound rule set and which VMs it is attached to. Use after list_firewalls to inspect a firewall\'s rules.',
);
