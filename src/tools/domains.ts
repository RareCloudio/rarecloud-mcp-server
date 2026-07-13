// Domain tools — read-only views of the account's registered domains and the
// pre-purchase catalog surface: the domain list + detail, a WHOIS availability
// check, per-TLD pricing, and the per-domain nameservers / registrant contact /
// DNS records / management snapshot. Read-only by design (same as the rest of
// this server); the matching setters (change nameservers / contact / DNS /
// dispatch a management action) are write operations not exposed here.

import { readList, readOne, readTool, encodeSegment } from './factories.js';

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

export const checkDomainAvailability = readTool({
  name: 'check_domain_availability',
  description:
    'Check whether a domain name is available to register — a pre-purchase WHOIS availability lookup for a single domain. Pass the full domain (e.g. example.com). Use before quoting a registration or suggesting an alternative name.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'The domain to check, e.g. example.com.' },
    },
    required: ['domain'],
    additionalProperties: false,
  },
  buildPath: (args) =>
    `/v1/domains/availability?${new URLSearchParams({ domain: String(args.domain) }).toString()}`,
});

export const getTldPricing = readList(
  'get_tld_pricing',
  '/v1/domains/tld-pricing',
  'List register / transfer / renew prices per TLD, in the account currency. Use to quote what a .com / .io / etc costs before recommending or ordering a domain.',
);

export const getDomainNameservers = readTool({
  name: 'get_domain_nameservers',
  description:
    'Get the nameservers currently set on an owned domain — where its DNS is delegated. Use to see the domain\'s delegation before recommending a change. Read-only; replacing the nameservers is a write and is not exposed as an MCP tool yet. The id comes from list_domains.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Domain id from list_domains.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/domains/${encodeSegment(args.id, 'id')}/nameservers`,
});

export const getDomainContacts = readTool({
  name: 'get_domain_contacts',
  description:
    'Get the registrant WHOIS contact on an owned domain (registrar-dependent). Use to review who the domain is registered to. Read-only; updating the contact is a write and is not exposed as an MCP tool yet. The id comes from list_domains.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Domain id from list_domains.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/domains/${encodeSegment(args.id, 'id')}/contacts`,
});

export const getDomainDns = readTool({
  name: 'get_domain_dns',
  description:
    'Get the DNS host records on an owned domain — its A / CNAME / MX / TXT / etc entries (registrar-dependent; returns a not-implemented error when the registrar exposes no DNS API). Use to read the domain\'s current records. Read-only; replacing the records is a write and is not exposed as an MCP tool yet. The id comes from list_domains.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Domain id from list_domains.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/domains/${encodeSegment(args.id, 'id')}/dns`,
});

export const getDomainManagement = readTool({
  name: 'get_domain_management',
  description:
    'Get the combined management snapshot for an owned domain in one call: status, expiry, auto-renew, WHOIS ID protection, nameservers, and transfer lock (per-registrar fields are null when the registrar exposes no API for them). Use as the one-stop "how is this domain configured?" read. The id comes from list_domains.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Domain id from list_domains.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/domains/${encodeSegment(args.id, 'id')}/manage`,
});
