// Domains WRITE tools (Parity Phase B, Task 7): register / transfer-in /
// renew a domain (all order-driven → money-spend, `confirm`-gated), plus
// set-nameservers / set-contacts / set-dns / manage (plain writes — no
// separate charge). Everything here builds on the shared `writeTool` factory
// so input validation, the confirm gate, `encodeSegment` path encoding, and
// the APIError -> errorResult mapping stay uniform with infra-write.ts /
// firewall-lb-write.ts / services-write.ts / k8s-write.ts. All scope
// domains:write (a distinct sellable category from services:write — see
// api/src/routes/v1-domains.ts header comment).
//
// None of these 7 tools carries `destructiveHint`: register/transfer/renew
// only spend money (reversible in the sense that nothing is torn down), and
// nameservers/contacts/dns/manage changes can always be set back. Only
// register_domain, transfer_domain, renew_domain carry `confirm` (they place
// a CHARGED order — see each endpoint's openapi description). No DELETE
// method appears in this brief, so the `callMethod`-discards-DELETE-body
// trap does not apply.
//
// Bodies + bounds re-confirmed against console openapi.json AND the route
// source (api/src/routes/v1-domains.ts):
//
//   - DEVIATION FROM BRIEF: set_domain_nameservers / manage_domain's
//     `nameservers` field — the brief's `set_domain_nameservers` row says
//     `nameservers:string[].min(1)`, but the PUT /domains/{id}/nameservers
//     request schema in openapi (AND the route source's NameserversInput)
//     both require `minItems: 2, maxItems: 5` ("Replace the owned domain's
//     nameservers (2-5)."). Same bounds appear on manage_domain's
//     `nameservers` field (used only when action='nameservers'). openapi
//     wins per the task rule; mirrored in both zod (.min(2).max(5)) and the
//     JSON inputSchema (minItems/maxItems) on both tools.
//   - register_domain / transfer_domain: openapi documents `years`
//     min:1/max:10/default:1 and `nameservers` maxItems:5 (no minItems — an
//     empty or 1-item array is allowed at registration/transfer time, unlike
//     the replace-nameservers endpoints above). Matches the brief exactly;
//     mirrored in both layers including the min side.
//   - renew_domain: openapi's requestBody is `required: false` (years/
//     autoRenew both optional; the WHOLE body may be absent) — matches the
//     brief's `{id, years?, autoRenew?}`. We still always send an object
//     (possibly `{}`), consistent with create_volume/reserve_ip's
//     omit-undefined-but-send-`{}` convention in infra-write.ts.
//   - set_domain_contacts: openapi's PUT /domains/{id}/contacts request body
//     is the bare `DomainContact` $ref (not wrapped), matching
//     add_firewall_rule's bare-FirewallRuleInput precedent in
//     firewall-lb-write.ts. `DomainContact` declares NO `required` array in
//     openapi (every field optional) — the route source's ContactsInput
//     agrees (all `.optional()`). Modeled as a nested `contact` object on the
//     tool's own input (per the brief), unwrapped into the bare body by
//     buildBody.
//   - set_domain_dns: openapi's `records` array item is `DnsRecord`
//     (required hostname/type/address, optional priority) — matches the
//     brief exactly.
//   - manage_domain: openapi declares `action` as a real enum
//     (nameservers/lock/autorenew/idprotect/epp) — matches the brief.
//
// Enrichments beyond the brief's bare cells / openapi's prose-only fields,
// pulled from route source, mirroring the Task-6 (firewall-lb-write.ts)
// precedent of mirroring single-field, non-cross-field format/business
// constraints client-side even when openapi only documents them as free text
// (no cross-field rule is mirrored here — there are none in this brief):
//   - `domain` (register/transfer) and every nameserver hostname
//     (register/transfer/set_domain_nameservers/manage_domain): openapi
//     types these as bare `string`; the route source validates both against
//     the SAME hostname-format regex (`DOMAIN_RE` / `NS_RE` in
//     v1-domains.ts, textually identical). Mirrored here as one shared
//     `HOSTNAME_RE` constant, applied via `.regex()` in zod and `.source` as
//     the JSON Schema `pattern` (derived, not hand-transcribed, so the two
//     layers cannot drift).
//   - `contact.email`: openapi documents `format: "email"` (informational);
//     the route enforces `z.string().email()`. Mirrored as zod `.email()` +
//     JSON Schema `format: 'email'`.
//   - `contact.country`: openapi's description says "2-letter ISO country
//     code" in prose only; the route enforces `.length(2)`. Mirrored as zod
//     `.length(2)` + JSON Schema `minLength`/`maxLength: 2`.
//   - DNS record `type`: openapi types it as bare `string` with a prose
//     description ("A | AAAA | CNAME | MX | TXT | NS | SRV | CAA"); the
//     route enforces a real `z.enum([...])` of those 8 values. Mirrored as a
//     zod enum + JSON Schema `enum`.
//   - DNS record `hostname`/`address` min(1) and `priority` min(0), and the
//     `records` array `.max(100)`: all route-source-only bounds (openapi is
//     silent on all four), mirrored the same way.
//
// Every dynamic path segment is the single param `id` (matching the
// read-tool convention in domains.ts) run through encodeSegment.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

// Shared hostname-format regex (route source: DOMAIN_RE / NS_RE in
// v1-domains.ts are textually identical). `.source` feeds the JSON Schema
// `pattern` for both fields so the two layers can't drift from each other.
const HOSTNAME_RE =
  /^(?=.{4,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const HOSTNAME_PATTERN = HOSTNAME_RE.source;

const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] as const;
const MANAGE_ACTIONS = ['nameservers', 'lock', 'autorenew', 'idprotect', 'epp'] as const;

// --- register_domain (POST /v1/domains, confirm — order → money-spend) -----

export const registerDomain: ToolDefinition = writeTool({
  name: 'register_domain',
  description:
    'Register a new domain name. Requires scope domains:write. SPENDS MONEY: places a register ORDER + ' +
    'invoice (WHMCS has no "register now" API) that the registrar fulfils once accepted/paid — the ' +
    'returned status starts Pending. Pass confirm:true only after the user has approved the cost. domain ' +
    "is the full name, e.g. example.com; years is the registration term (1-10, default 1); nameservers " +
    'is an optional list of up to 5 custom nameserver hostnames (omit to use the registrar default); ' +
    'idProtection/dnsManagement are optional WHOIS-privacy / DNS-hosting add-ons (registrar-dependent). ' +
    'Check availability first with check_domain_availability and price with get_tld_pricing.',
  method: 'POST',
  input: z
    .object({
      domain: z.string().regex(HOSTNAME_RE, 'Enter a valid domain (e.g. example.com).'),
      years: z.number().int().min(1).max(10).optional(),
      nameservers: z
        .array(z.string().regex(HOSTNAME_RE, 'Enter valid nameserver hostnames.'))
        .max(5)
        .optional(),
      idProtection: z.boolean().optional(),
      dnsManagement: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', pattern: HOSTNAME_PATTERN, description: 'The domain to register, e.g. example.com.' },
      years: { type: 'integer', minimum: 1, maximum: 10, description: 'Registration term in years (1-10, default 1).' },
      nameservers: {
        type: 'array',
        items: { type: 'string', pattern: HOSTNAME_PATTERN },
        maxItems: 5,
        description: 'Optional custom nameservers (up to 5); omit to use the registrar default.',
      },
      idProtection: { type: 'boolean', description: 'Optional WHOIS-privacy add-on (registrar-dependent).' },
      dnsManagement: { type: 'boolean', description: 'Optional DNS-hosting add-on (registrar-dependent).' },
    },
    required: ['domain'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/domains',
  buildBody: (a) => {
    const body: Record<string, unknown> = { domain: a.domain };
    if (a.years !== undefined) body.years = a.years;
    if (a.nameservers !== undefined) body.nameservers = a.nameservers;
    if (a.idProtection !== undefined) body.idProtection = a.idProtection;
    if (a.dnsManagement !== undefined) body.dnsManagement = a.dnsManagement;
    return body;
  },
  confirm: true,
});

// --- transfer_domain (POST /v1/domains/transfers, confirm — money-spend) ---

export const transferDomain: ToolDefinition = writeTool({
  name: 'transfer_domain',
  description:
    'Transfer a domain in from another registrar. Requires scope domains:write. SPENDS MONEY: places a ' +
    'transfer-in ORDER + invoice using the EPP/auth code from the losing registrar; the registrar fulfils ' +
    'once accepted/paid — the returned status starts Pending. Pass confirm:true only after the user has ' +
    'approved the cost. domain is the full name, e.g. example.com; epp is the EPP/auth code from the ' +
    'losing registrar; years is the term to add on transfer (1-10, default 1); nameservers is an optional ' +
    'list of up to 5 custom nameserver hostnames; idProtection is an optional WHOIS-privacy add-on ' +
    '(registrar-dependent).',
  method: 'POST',
  input: z
    .object({
      domain: z.string().regex(HOSTNAME_RE, 'Enter a valid domain (e.g. example.com).'),
      epp: z.string().min(1, 'An EPP / auth code is required to transfer a domain in.'),
      years: z.number().int().min(1).max(10).optional(),
      nameservers: z
        .array(z.string().regex(HOSTNAME_RE, 'Enter valid nameserver hostnames.'))
        .max(5)
        .optional(),
      idProtection: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', pattern: HOSTNAME_PATTERN, description: 'The domain to transfer in, e.g. example.com.' },
      epp: { type: 'string', minLength: 1, description: 'EPP / auth code from the losing registrar.' },
      years: { type: 'integer', minimum: 1, maximum: 10, description: 'Term to add on transfer (1-10, default 1).' },
      nameservers: {
        type: 'array',
        items: { type: 'string', pattern: HOSTNAME_PATTERN },
        maxItems: 5,
        description: 'Optional custom nameservers (up to 5).',
      },
      idProtection: { type: 'boolean', description: 'Optional WHOIS-privacy add-on (registrar-dependent).' },
    },
    required: ['domain', 'epp'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/domains/transfers',
  buildBody: (a) => {
    const body: Record<string, unknown> = { domain: a.domain, epp: a.epp };
    if (a.years !== undefined) body.years = a.years;
    if (a.nameservers !== undefined) body.nameservers = a.nameservers;
    if (a.idProtection !== undefined) body.idProtection = a.idProtection;
    return body;
  },
  confirm: true,
});

// --- renew_domain (POST /v1/domains/{id}/renew, confirm — money-spend) -----

export const renewDomain: ToolDefinition = writeTool({
  name: 'renew_domain',
  description:
    'Renew an owned domain. Requires scope domains:write. SPENDS MONEY: creates a CHARGED renewal order + ' +
    'invoice (paid from credit or via the invoice flow, same as register/transfer) and optionally flips ' +
    'auto-renew in the same call; the registrar fulfils once the order is paid — the returned status ' +
    'starts Pending. Pass confirm:true only after the user has approved the cost. id comes from ' +
    'list_domains; years is the renewal term (1-10, default 1); autoRenew optionally sets the domain\'s ' +
    'auto-renew flag.',
  method: 'POST',
  input: z
    .object({
      id: z.string().min(1),
      years: z.number().int().min(1).max(10).optional(),
      autoRenew: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Domain id from list_domains.' },
      years: { type: 'integer', minimum: 1, maximum: 10, description: 'Renewal term in years (1-10, default 1).' },
      autoRenew: { type: 'boolean', description: "Optionally set the domain's auto-renew flag in the same call." },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/domains/${encodeSegment(a.id, 'id')}/renew`,
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.years !== undefined) body.years = a.years;
    if (a.autoRenew !== undefined) body.autoRenew = a.autoRenew;
    return body;
  },
  confirm: true,
});

// --- set_domain_nameservers (PUT /v1/domains/{id}/nameservers, no gate) ----

export const setDomainNameservers: ToolDefinition = writeTool({
  name: 'set_domain_nameservers',
  description:
    "Replace an owned domain's nameservers (2-5). Requires scope domains:write. Plain write — not gated. " +
    'id comes from list_domains. For a single-action alternative see manage_domain with ' +
    "action:'nameservers'.",
  method: 'PUT',
  input: z
    .object({
      id: z.string().min(1),
      nameservers: z
        .array(z.string().regex(HOSTNAME_RE, 'Enter valid nameserver hostnames.'))
        .min(2, 'At least two nameservers are required.')
        .max(5, 'At most five nameservers are supported.'),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Domain id from list_domains.' },
      nameservers: {
        type: 'array',
        items: { type: 'string', pattern: HOSTNAME_PATTERN },
        minItems: 2,
        maxItems: 5,
        description: 'Replacement nameservers (2-5 required).',
      },
    },
    required: ['id', 'nameservers'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/domains/${encodeSegment(a.id, 'id')}/nameservers`,
  buildBody: (a) => ({ nameservers: a.nameservers }),
});

// --- set_domain_contacts (PUT /v1/domains/{id}/contacts, no gate) ----------

const DomainContactSchema = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    organisation: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    address1: z.string().optional(),
    address2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postcode: z.string().optional(),
    country: z.string().length(2, 'Country must be a 2-letter ISO code.').optional(),
  })
  .strict();

const DOMAIN_CONTACT_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    firstName: { type: 'string', minLength: 1 },
    lastName: { type: 'string', minLength: 1 },
    organisation: { type: 'string' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string' },
    address1: { type: 'string' },
    address2: { type: 'string' },
    city: { type: 'string' },
    state: { type: 'string' },
    postcode: { type: 'string' },
    country: { type: 'string', minLength: 2, maxLength: 2, description: '2-letter ISO country code.' },
  },
  additionalProperties: false,
};

export const setDomainContacts: ToolDefinition = writeTool({
  name: 'set_domain_contacts',
  description:
    "Update an owned domain's registrant WHOIS contact (registrar-dependent). Requires scope " +
    'domains:write. Plain write — not gated. id comes from list_domains; contact carries only the fields ' +
    'to change (all optional) — firstName, lastName, organisation, email, phone, address1, address2, ' +
    'city, state, postcode, country (2-letter ISO code).',
  method: 'PUT',
  input: z.object({ id: z.string().min(1), contact: DomainContactSchema }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Domain id from list_domains.' },
      contact: DOMAIN_CONTACT_JSON_SCHEMA,
    },
    required: ['id', 'contact'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/domains/${encodeSegment(a.id, 'id')}/contacts`,
  buildBody: (a) => {
    const c = a.contact;
    const body: Record<string, unknown> = {};
    if (c.firstName !== undefined) body.firstName = c.firstName;
    if (c.lastName !== undefined) body.lastName = c.lastName;
    if (c.organisation !== undefined) body.organisation = c.organisation;
    if (c.email !== undefined) body.email = c.email;
    if (c.phone !== undefined) body.phone = c.phone;
    if (c.address1 !== undefined) body.address1 = c.address1;
    if (c.address2 !== undefined) body.address2 = c.address2;
    if (c.city !== undefined) body.city = c.city;
    if (c.state !== undefined) body.state = c.state;
    if (c.postcode !== undefined) body.postcode = c.postcode;
    if (c.country !== undefined) body.country = c.country;
    return body;
  },
});

// --- set_domain_dns (PUT /v1/domains/{id}/dns, no gate) ---------------------

const DnsRecordSchema = z
  .object({
    hostname: z.string().min(1),
    type: z.enum(DNS_RECORD_TYPES),
    address: z.string().min(1),
    priority: z.number().int().min(0).optional(),
  })
  .strict();

export const setDomainDns: ToolDefinition = writeTool({
  name: 'set_domain_dns',
  description:
    "Replace an owned domain's DNS host records (registrar-dependent — returns a not-implemented error " +
    'when the registrar exposes no DNS API). Requires scope domains:write. Plain write — not gated. id ' +
    'comes from list_domains. records is the full replacement set (up to 100); each record needs ' +
    "hostname (e.g. '@', 'www', 'mail'), type (A/AAAA/CNAME/MX/TXT/NS/SRV/CAA), and address (the record " +
    'value/target); priority is used for MX/SRV records.',
  method: 'PUT',
  input: z
    .object({
      id: z.string().min(1),
      records: z.array(DnsRecordSchema).max(100),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Domain id from list_domains.' },
      records: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            hostname: { type: 'string', minLength: 1, description: "Record name, e.g. '@', 'www', 'mail'." },
            type: { type: 'string', enum: [...DNS_RECORD_TYPES], description: 'DNS record type.' },
            address: { type: 'string', minLength: 1, description: 'Record value / target.' },
            priority: { type: 'integer', minimum: 0, description: 'For MX/SRV records.' },
          },
          required: ['hostname', 'type', 'address'],
          additionalProperties: false,
        },
        description: 'Full replacement set of DNS host records.',
      },
    },
    required: ['id', 'records'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/domains/${encodeSegment(a.id, 'id')}/dns`,
  buildBody: (a) => ({
    records: a.records.map((r) => {
      const rec: Record<string, unknown> = { hostname: r.hostname, type: r.type, address: r.address };
      if (r.priority !== undefined) rec.priority = r.priority;
      return rec;
    }),
  }),
});

// --- manage_domain (POST /v1/domains/{id}/manage, no gate) -----------------

export const manageDomain: ToolDefinition = writeTool({
  name: 'manage_domain',
  description:
    'Dispatch a single domain management action. Requires scope domains:write. Plain write — not gated. ' +
    'id comes from list_domains. action selects the operation: nameservers (replace 2-5, pass ' +
    'nameservers), lock (transfer lock, pass enabled), autorenew (pass enabled), idprotect (WHOIS ' +
    'privacy, pass enabled), epp (emails the transfer/EPP code to the registrant — no extra fields). See ' +
    'get_domain_management for the current state before choosing an action.',
  method: 'POST',
  input: z
    .object({
      id: z.string().min(1),
      action: z.enum(MANAGE_ACTIONS),
      nameservers: z
        .array(z.string().regex(HOSTNAME_RE, 'Enter valid nameserver hostnames.'))
        .min(2, 'At least two nameservers are required.')
        .max(5, 'At most five nameservers are supported.')
        .optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Domain id from list_domains.' },
      action: { type: 'string', enum: [...MANAGE_ACTIONS], description: 'The registrar action to dispatch.' },
      nameservers: {
        type: 'array',
        items: { type: 'string', pattern: HOSTNAME_PATTERN },
        minItems: 2,
        maxItems: 5,
        description: "Required when action is 'nameservers'.",
      },
      enabled: { type: 'boolean', description: "Used by lock / autorenew / idprotect actions." },
    },
    required: ['id', 'action'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/domains/${encodeSegment(a.id, 'id')}/manage`,
  buildBody: (a) => {
    const body: Record<string, unknown> = { action: a.action };
    if (a.nameservers !== undefined) body.nameservers = a.nameservers;
    if (a.enabled !== undefined) body.enabled = a.enabled;
    return body;
  },
});
