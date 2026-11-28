// Domain tools — read-only views of the account's registered domains and the
// pre-purchase catalog surface: the domain list + detail, a WHOIS availability
// check, per-TLD pricing, a price and credit quote for several domains, and the
// per-domain nameservers / registrant contact /
// DNS records / management snapshot. Read-only by design (same as the rest of
// this server); the matching setters (change nameservers / contact / DNS /
// dispatch a management action) are the gated write tools in domains-write.ts.

import { z } from 'zod';
import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';
import { readList, readOne, readTool, defineReadTool, encodeSegment, formatZodError } from './factories.js';

export const listDomains = readList(
  'list_domains',
  '/v1/domains',
  'List registered domains: id, name, status, expiry, auto-renew, and apiAccess ("full", or "read_only" when the user made the domain read-only for agents and API tokens: no tool can change it, see list_api_access; missing means "full"). Use for "what domains do I own?" or to find a domain id.',
);

export const getDomain = readOne(
  'get_domain',
  '/v1/domains',
  'Get one domain: nameservers, transfer lock, WHOIS privacy, auto-renew, expiry, and apiAccess ("full", or "read_only" when the user made it read-only for agents and API tokens: no tool can change its nameservers, DNS, contacts or settings; missing means "full"). Use after list_domains for management detail.',
  'id',
  { idSource: 'list_domains' },
);

export const checkDomainAvailability = readTool({
  name: 'check_domain_availability',
  description:
    'Check whether a domain name is available to register: a pre-purchase WHOIS availability lookup for a single domain. Pass the full domain (e.g. example.com). Use before quoting a registration or suggesting an alternative name.',
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

// quote_domains: POST /v1/domains/quote places and reserves nothing, so it is a
// READ tool (read annotations, no confirm gate, no idempotency_key), like
// estimate_limits. readTool only issues GETs, hence the hand-written handler.
//
// Bounds from the API (openapi + api/src/routes/v1-domains.ts): the API takes up to
// 100 raw entries of at most 300 characters and refuses more than 20 after trimming,
// lowercasing and de-duplication. This tool advertises 1-20 entries, the number the
// API actually prices. There is deliberately no domain-name pattern: the API answers
// a malformed name as an item with status `invalid`, so the agent sees why per domain.
const QUOTE_TYPES = ['register', 'transfer'] as const;

const quoteInput = z
  .object({
    domains: z
      .array(z.string().min(1, 'Enter a domain.').max(300))
      .min(1, 'Enter at least one domain.')
      .max(20, 'At most 20 domains per quote.'),
    type: z.enum(QUOTE_TYPES).optional(),
    years: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const quoteDomains: ToolDefinition = defineReadTool({
  name: 'quote_domains',
  description:
    `Quote up to 20 domains before ordering them: price, availability and whether real credit covers ` +
    `the total. Requires scope domains:read. It places nothing and reserves nothing. type is register ` +
    `(default) or transfer; years is the period (1-10, default 1). Each item has domain, status ` +
    `(available: can be ordered; unavailable: already registered; premium: not orderable here, contact ` +
    `support; invalid: not a valid domain name; no_pricing: the extension is not offered, or not for ` +
    `this many years; error: the availability check failed, try again), orderable, perYearCents (the ` +
    `1-year price), netCents (the price of the requested period, before VAT) and message. Totals cover ` +
    `the orderable items only: subtotalCents, vatCents (taxRatePercent) and totalCents; totalCents ` +
    `includes VAT. Money is integer cents of the account currency (currency). Domains are paid from real ` +
    `credit only, never promotional bonus: affordable says whether real credit covers totalCents, and ` +
    `realCreditCents and shortfallCents are null unless the token also has billing:read. Availability ` +
    `checks are rate-limited per account: every register quote and every register_domains order spends ` +
    `one check per domain from a shared budget per minute (429 RATE_LIMITED when it runs out), so do ` +
    `not re-quote the same domains in a loop; quote once and reuse the answer. Use it before ` +
    `register_domains with the same domains and years, and show the user totalCents before asking them ` +
    `to approve the order.`,
  inputSchema: {
    type: 'object',
    properties: {
      domains: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 300 },
        minItems: 1,
        maxItems: 20,
        description: 'The domains to quote, one per entry (e.g. example.com); 1 to 20.',
      },
      type: {
        type: 'string',
        enum: [...QUOTE_TYPES],
        description: 'register (default) or transfer.',
      },
      years: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Registration or transfer period in years (1-10, default 1).',
      },
    },
    required: ['domains'],
    additionalProperties: false,
  },
  async handler(client, args) {
    const parsed = quoteInput.safeParse(args);
    if (!parsed.success) {
      return errorResult(`Invalid input for quote_domains: ${formatZodError(parsed.error)}`);
    }
    const body: Record<string, unknown> = { domains: parsed.data.domains };
    if (parsed.data.type !== undefined) body.type = parsed.data.type;
    if (parsed.data.years !== undefined) body.years = parsed.data.years;
    try {
      return jsonResult(await client.post('/v1/domains/quote', body));
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
});

export const getDomainNameservers = readTool({
  name: 'get_domain_nameservers',
  description:
    'Get the nameservers currently set on an owned domain: where its DNS is delegated. Use to see the domain\'s delegation before recommending a change. Read-only; change them with set_domain_nameservers. The id comes from list_domains.',
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
    'Get the registrant WHOIS contact on an owned domain (registrar-dependent). Use to review who the domain is registered to. Read-only; change it with set_domain_contacts. The id comes from list_domains.',
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
    'Get the DNS host records on an owned domain: its A / CNAME / MX / TXT / etc entries (registrar-dependent; returns a not-implemented error when the registrar exposes no DNS API). Use to read the domain\'s current records. Read-only; replace them with set_domain_dns. The id comes from list_domains.',
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
