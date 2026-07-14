// Residential-proxy WRITE tools (Parity Phase B, Task 9): order / renew /
// auto-renew / cancel a proxy service, manage ISP authentication (method /
// credentials / IP whitelist), request an included IP replacement, and
// create/delete a GB Residential proxy-request. Everything here builds on
// the shared `writeTool` factory so input validation, the confirm gate,
// `encodeSegment` path encoding, and the APIError -> errorResult mapping
// stay uniform with infra-write.ts / services-write.ts / domains-write.ts.
//
// SCOPE: all 11 tools are services:write — there is NO proxy-specific
// scope. Every description says so explicitly: an agent holding
// services:write can manage proxies AND production VMs/clusters/etc (same
// scope, no finer split), so a caller granting services:write to an agent
// is granting both surfaces at once.
//
// order_proxy is the one `oneOf` union (US Residential ISP vs GB
// Residential, discriminated by `kind`). The union flows through the
// `writeTool<S extends z.ZodTypeAny>` factory bound natively (widened in
// e569f9d) — no cast needed, unlike an earlier draft of this task's brief
// that assumed a `ZodObject`-only bound.
//
// Bodies + bounds re-confirmed against console openapi.json AND the route
// source (api/src/routes/v1-proxies.ts):
//
//   - order_proxy: openapi's POST /proxies requestBody is `oneOf` ["US
//     Residential ISP", "GB Residential"] and matches the brief's exemplar
//     verbatim — ISP required [ips, cycle, locationId, protocol, authType]
//     with `kind` optional (defaults residential-isp for back-compat); GB
//     required [kind, gb] with kind pinned to the literal 'residential-gb'.
//     Implemented as given, no deviation. Task 10 review pass: openapi types
//     `ips`/`gb` as bare `integer` and `locationId` as bare `string`, but the
//     route source's `IspOrderInput`/`GbOrderInput` (v1-proxies.ts:117,119,127)
//     enforce `.positive()` on `ips`/`gb` and `.min(1)` on `locationId`.
//     Mirrored here (`ips`/`gb` -> `.int().positive()` + JSON `minimum: 1`;
//     `locationId` -> `.min(1)` + JSON `minLength: 1`), same "min side" rule as
//     the other route-source enrichments below.
//   - DEVIATION FROM BRIEF: renew_proxy's `periods` — the brief's row says
//     `periods?:int` (any integer), but openapi's POST /proxies/{id}/renew
//     request schema documents `periods` as `integer` with `enum:[1,3,6,12]`
//     and `default:1` (bulk-discount tiers: 3 -> 5%, 6 -> 10%, 12 -> 20%).
//     openapi wins per the task rule; mirrored as a literal-union in zod and
//     `enum`+`default` in the JSON inputSchema. (The route itself silently
//     falls back to 1 for an out-of-set value rather than erroring — we
//     still reject client-side against the documented contract so a caller
//     finds out immediately rather than being silently overridden.)
//   - DEVIATION FROM BRIEF: create_proxy_request's `rotationInterval` — the
//     brief's row types it as bare `string`, but openapi documents a real
//     enum (`all`, `high`, `1min`, `10min`, `30min`) and the route source's
//     `ROTATION_INTERVALS` constant agrees. openapi wins; mirrored as a zod
//     enum + JSON Schema `enum`.
//   - set_proxy_credentials: openapi's PUT /proxies/{id}/auth/credentials
//     documents `username`/`password` as `maxLength:64` each but is SILENT
//     on a minimum; the route source's `CredentialsInput` enforces
//     `.min(1)` server-side on both (in addition to `.trim()`, not
//     mirrored here — trimming is a value transform, not a validation
//     bound, and no other write tool in this repo transforms input values).
//     Per the "mirror both layers incl. the min side" rule, `.min(1)` is
//     added here too (enrichment beyond the brief's bare cells / openapi's
//     silence, matching the Task 7 domains-write.ts precedent).
//   - add_proxy_whitelisted_ip / remove_proxy_whitelisted_ip: openapi types
//     `ip` as a bare `string` (no format), but the route source validates
//     it as `z.union([z.ipv4(), z.ipv6()])` on BOTH the add body and the
//     delete path segment. Mirrored here via zod's `z.string().ip()`
//     (accepts v4 or v6, equivalent to the route's union) — an enrichment
//     from route source; the JSON Schema keeps a plain string (no combined
//     ipv4-or-ipv6 `format` keyword exists) with a description noting the
//     accepted shape.
//   - create_proxy_request: openapi types `countryId`/`proxyCount` as bare
//     `integer` (no bound), but the route source's `ProxyRequestInput`
//     enforces `.positive()` on both. Mirrored as `.int().positive()` in
//     zod and `minimum: 1` in the JSON Schema (enrichment from route
//     source, same "min side" rule as above).
//   - All other METHOD/path/body shapes (set_proxy_auto_renew,
//     cancel_proxy, set_proxy_auth_method, request_proxy_replacement,
//     delete_proxy_request) matched the brief exactly.
//
// Secret hygiene: set_proxy_credentials carries LIVE proxy credentials in
// its REQUEST body (the response is just `{ok:true}` — no echo). Per the
// same treat-as-secret precedent as get_proxy_auth / get_proxy_list (Phase
// A) and set_service_password / reset_service_password (services-write.ts),
// the description says the values are secrets that must never be echoed or
// logged, and a dedicated test proves an invalid value never leaks into the
// zod validation error text.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

const SCOPE_NOTE =
  'proxy writes share the same scope as VM/k8s mutations — there is no proxy-specific scope';

const RENEW_PERIODS = [1, 3, 6, 12] as const;
const AUTH_METHODS = ['ip', 'password', 'combined'] as const;
const ROTATION_INTERVALS = ['all', 'high', '1min', '10min', '30min'] as const;

// --- order_proxy (POST /v1/proxies, confirm — money-spend; oneOf union) ----
// POST /v1/proxies body is a oneOf: US Residential ISP | GB Residential.
const orderProxyInput = z.union([
  z
    .object({
      kind: z.literal('residential-isp').optional(),
      ips: z.number().int().positive(), // tier: 1,3,5,10,20,25,50,100,150,200
      cycle: z.enum(['day', 'week', 'month']),
      locationId: z.string().min(1),
      protocol: z.enum(['http', 'socks']),
      authType: z.enum(['password', 'combined']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('residential-gb'),
      gb: z.number().int().positive(), // bucket: 1,2,5,10,50,100,250,500,1000 (monthly only)
    })
    .strict(),
]);

export const orderProxy: ToolDefinition = writeTool({
  name: 'order_proxy',
  description:
    `Order a new residential proxy plan and CHARGE the account. Requires scope services:write (${SCOPE_NOTE}). ` +
    'Two shapes: a US Residential ISP plan {ips, cycle, locationId, protocol, authType} (discover options with ' +
    'get_proxy_catalog / list_regions), or a GB Residential bucket {kind:"residential-gb", gb}. SPENDS ' +
    'MONEY — pass confirm:true only after the user approves the plan and cost.',
  method: 'POST',
  input: orderProxyInput,
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['residential-isp', 'residential-gb'], description: 'Plan family; defaults to residential-isp.' },
      ips: { type: 'integer', minimum: 1, description: 'ISP: IP-count tier (1,3,5,10,20,25,50,100,150,200).' },
      cycle: { type: 'string', enum: ['day', 'week', 'month'], description: 'ISP: billing cycle.' },
      locationId: { type: 'string', minLength: 1, description: 'ISP: catalog location id.' },
      protocol: { type: 'string', enum: ['http', 'socks'], description: 'ISP: protocol.' },
      authType: { type: 'string', enum: ['password', 'combined'], description: 'ISP: auth type.' },
      gb: { type: 'integer', minimum: 1, description: 'GB: bucket tier (1,2,5,10,50,100,250,500,1000; monthly only).' },
    },
    required: [],
    additionalProperties: false,
  },
  buildPath: () => '/v1/proxies',
  buildBody: (a) => a,
  confirm: true,
});

// --- renew_proxy (POST /v1/proxies/{id}/renew, confirm — money-spend) -----
// DEVIATION FROM BRIEF: `periods` is restricted to openapi's documented enum
// [1,3,6,12] (bulk-discount tiers), not a bare int as the brief's row says.

export const renewProxy: ToolDefinition = writeTool({
  name: 'renew_proxy',
  description:
    `Renew a proxy service for another billing term. Requires scope services:write (${SCOPE_NOTE}). SPENDS ` +
    'MONEY: creates a CHARGED renewal invoice, settled from credit/bonus when available. periods (1, 3, 6, ' +
    'or 12 — default 1) selects how many terms to prolong in one call; bulk periods carry a discount (3 -> ' +
    '5%, 6 -> 10%, 12 -> 20%). Pass confirm:true only after the user has approved the cost. id comes from ' +
    'list_proxies.',
  method: 'POST',
  input: z
    .object({
      id: z.string().min(1),
      periods: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies.' },
      periods: {
        type: 'integer',
        enum: [1, 3, 6, 12],
        default: 1,
        description: 'How many billing periods to extend (bulk discounts: 3 -> 5%, 6 -> 10%, 12 -> 20%).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/renew`,
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.periods !== undefined) body.periods = a.periods;
    return body;
  },
  confirm: true,
});

// --- set_proxy_auto_renew (POST /v1/proxies/{id}/auto-renew, no gate) -----

export const setProxyAutoRenew: ToolDefinition = writeTool({
  name: 'set_proxy_auto_renew',
  description:
    `Turn a proxy service's auto-renew on or off. Requires scope services:write (${SCOPE_NOTE}). ISP proxy ` +
    'services only. Plain write — not gated (no charge happens now; a future auto-renewal will still spend ' +
    'money on its own schedule). id comes from list_proxies.',
  method: 'POST',
  input: z.object({ id: z.string().min(1), enabled: z.boolean() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies (ISP only).' },
      enabled: { type: 'boolean', description: 'true enables auto-renew; false disables it.' },
    },
    required: ['id', 'enabled'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/auto-renew`,
  buildBody: (a) => ({ enabled: a.enabled }),
});

// --- cancel_proxy (POST /v1/proxies/{id}/cancel, confirm+destr) -----------

export const cancelProxy: ToolDefinition = writeTool({
  name: 'cancel_proxy',
  description:
    `Cancel a proxy service (ISP, GB Residential, or mobile — any kind). Requires scope services:write ` +
    `(${SCOPE_NOTE}). Prepaid semantics: flags the service to stop auto-renewing; it stays usable until its ` +
    'paid expiry, then ends normally (no upstream teardown call, no refund). cancel:true (the default) ' +
    'cancels at period end; cancel:false undoes a prior cancel and restores auto-renew. IRREVERSIBLE in the ' +
    'sense that the service will stop working at expiry unless undone first — pass confirm:true only after ' +
    'the user has explicitly approved. id comes from list_proxies.',
  method: 'POST',
  input: z.object({ id: z.string().min(1), cancel: z.boolean().optional() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies.' },
      cancel: {
        type: 'boolean',
        description: 'true (default) cancels at period end; false undoes a prior cancel.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/cancel`,
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.cancel !== undefined) body.cancel = a.cancel;
    return body;
  },
  confirm: true,
  destructiveHint: true,
});

// --- set_proxy_auth_method (PATCH /v1/proxies/{id}/auth, no gate) ---------

export const setProxyAuthMethod: ToolDefinition = writeTool({
  name: 'set_proxy_auth_method',
  description:
    `Switch a proxy service's authentication method (ip / password / combined). Requires scope ` +
    `services:write (${SCOPE_NOTE}). ISP proxy services only. Plain write — not gated. Switching to 'ip' ` +
    "relies on add_proxy_whitelisted_ip entries instead of a username/password. Use get_proxy_auth first to " +
    'see the current method. id comes from list_proxies.',
  method: 'PATCH',
  input: z.object({ id: z.string().min(1), method: z.enum(AUTH_METHODS) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies (ISP only).' },
      method: { type: 'string', enum: [...AUTH_METHODS], description: 'The authentication method to switch to.' },
    },
    required: ['id', 'method'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/auth`,
  buildBody: (a) => ({ method: a.method }),
});

// --- set_proxy_credentials (PUT /v1/proxies/{id}/auth/credentials, no gate) -
// SECURITY: username/password are secrets sent in the REQUEST body — never
// echo or log them. The response is just {ok:true} (no echo server-side
// either). See file header for the min(1)/max(64) enrichment from route
// source (openapi is silent on the minimum).

export const setProxyCredentials: ToolDefinition = writeTool({
  name: 'set_proxy_credentials',
  description:
    `Set a proxy service's username/password credentials. Requires scope services:write (${SCOPE_NOTE}). ISP ` +
    'proxy services only. username and password are secrets (1-64 chars each) — never echo them back to the ' +
    'user or log them; the response does not return them either. Plain write — not gated (see ' +
    'set_proxy_auth_method to also flip the auth method itself). id comes from list_proxies.',
  method: 'PUT',
  input: z
    .object({
      id: z.string().min(1),
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(64),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies (ISP only).' },
      username: { type: 'string', minLength: 1, maxLength: 64, description: 'New proxy username (1-64 chars). Never echoed or logged.' },
      password: { type: 'string', minLength: 1, maxLength: 64, description: 'New proxy password (1-64 chars). Never echoed or logged.' },
    },
    required: ['id', 'username', 'password'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/auth/credentials`,
  buildBody: (a) => ({ username: a.username, password: a.password }),
});

// --- add_proxy_whitelisted_ip (POST .../auth/whitelisted-ips, no gate) ----

export const addProxyWhitelistedIp: ToolDefinition = writeTool({
  name: 'add_proxy_whitelisted_ip',
  description:
    `Add an IP address to a proxy service's whitelist (used by the 'ip' auth method). Requires scope ` +
    `services:write (${SCOPE_NOTE}). ISP proxy services only. ip must be a valid IPv4 or IPv6 address — use ` +
    "get_proxy_auth's yourIp field to whitelist the caller's own detected IP. Plain write — not gated. id " +
    'comes from list_proxies.',
  method: 'POST',
  input: z.object({ id: z.string().min(1), ip: z.string().ip() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies (ISP only).' },
      ip: { type: 'string', description: 'IPv4 or IPv6 address to whitelist.' },
    },
    required: ['id', 'ip'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/auth/whitelisted-ips`,
  buildBody: (a) => ({ ip: a.ip }),
});

// --- remove_proxy_whitelisted_ip (DELETE .../whitelisted-ips/{ip}, confirm+destr) -

export const removeProxyWhitelistedIp: ToolDefinition = writeTool({
  name: 'remove_proxy_whitelisted_ip',
  description:
    `Remove an IP address from a proxy service's whitelist. Requires scope services:write (${SCOPE_NOTE}). ISP ` +
    'proxy services only. IRREVERSIBLE: that address immediately loses IP-based access to the proxy. Pass ' +
    'confirm:true only after the user has explicitly approved. id comes from list_proxies; ip comes from ' +
    'get_proxy_auth.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1), ip: z.string().ip() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies (ISP only).' },
      ip: { type: 'string', description: 'IPv4 or IPv6 address to remove from the whitelist (from get_proxy_auth).' },
    },
    required: ['id', 'ip'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/auth/whitelisted-ips/${encodeSegment(a.ip, 'ip')}`,
  confirm: true,
  destructiveHint: true,
});

// --- request_proxy_replacement (POST /v1/proxies/{id}/replacements, no gate) -

export const requestProxyReplacement: ToolDefinition = writeTool({
  name: 'request_proxy_replacement',
  description:
    `Request an IP replacement for a proxy service, consuming the included monthly allowance (1/month). ` +
    `Requires scope services:write (${SCOPE_NOTE}). ISP proxy services only. Opens a support ticket that ` +
    'fulfils the swap; check get_proxy_replacements first to confirm an allowance is available this month — ' +
    'the request is refused server-side once the allowance is used. Plain write — not gated. id comes from ' +
    'list_proxies.',
  method: 'POST',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Proxy service id from list_proxies (ISP only).' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/replacements`,
});

// --- create_proxy_request (POST /v1/proxies/{id}/proxy-requests, no gate) -
// DEVIATION FROM BRIEF: rotationInterval is restricted to openapi's/the
// route's real enum, not a bare string as the brief's row says.

export const createProxyRequest: ToolDefinition = writeTool({
  name: 'create_proxy_request',
  description:
    `Create a proxy-request (country + rotation-interval + count group) on a GB Residential bucket, ` +
    `allocating endpoints from it. Requires scope services:write (${SCOPE_NOTE}). GB Residential only — ISP ` +
    'fixed-IP plans expose their endpoints directly via get_proxy_list. countryId comes from ' +
    'list_gb_residential_countries; rotationInterval comes from list_gb_rotation_intervals. Plain write — ' +
    'not gated. id comes from list_proxies (a GB Residential service).',
  method: 'POST',
  input: z
    .object({
      id: z.string().min(1),
      countryId: z.number().int().positive(),
      proxyCount: z.number().int().positive(),
      rotationInterval: z.enum(ROTATION_INTERVALS),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'GB Residential proxy service id from list_proxies.' },
      countryId: { type: 'integer', minimum: 1, description: 'A country id from list_gb_residential_countries.' },
      proxyCount: { type: 'integer', minimum: 1, description: 'How many proxies to allocate.' },
      rotationInterval: {
        type: 'string',
        enum: [...ROTATION_INTERVALS],
        description: 'Rotation interval id from list_gb_rotation_intervals.',
      },
    },
    required: ['id', 'countryId', 'proxyCount', 'rotationInterval'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/proxy-requests`,
  buildBody: (a) => ({ countryId: a.countryId, proxyCount: a.proxyCount, rotationInterval: a.rotationInterval }),
});

// --- delete_proxy_request (DELETE .../proxy-requests/{reqId}, confirm+destr) -

export const deleteProxyRequest: ToolDefinition = writeTool({
  name: 'delete_proxy_request',
  description:
    `Delete a proxy-request from a GB Residential bucket. Requires scope services:write (${SCOPE_NOTE}). GB ` +
    'Residential only. IRREVERSIBLE: the allocated endpoints stop working immediately. Pass confirm:true ' +
    'only after the user has explicitly approved. id comes from list_proxies; reqId comes from ' +
    'list_proxy_requests.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1), reqId: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'GB Residential proxy service id from list_proxies.' },
      reqId: { type: 'string', minLength: 1, description: 'Proxy-request id from list_proxy_requests.' },
    },
    required: ['id', 'reqId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/proxies/${encodeSegment(a.id, 'id')}/proxy-requests/${encodeSegment(a.reqId, 'reqId')}`,
  confirm: true,
  destructiveHint: true,
});
