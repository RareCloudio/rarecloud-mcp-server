// Residential-proxy tools — read-only views of the legacy residential-proxy
// product. Two flavors: ISP (fixed IP-count plans whose endpoints are listed
// directly) and GB Residential (bandwidth buckets on which you create
// "proxy-requests" — country + rotation-interval groups that allocate
// endpoints). Reads here cover: the service list/detail, the live proxy list,
// auth settings, GB metadata (countries, rotation intervals), the
// proxy-requests list + their per-request proxy lists, and the replacement
// allowance. Ordering, renewing, cancelling, and changing
// auth/whitelist are the write tools in proxies-write.ts.
//
// get_proxy_list and get_proxy_request_list return LIVE proxy credentials
// (ip, port, username, password), and get_proxy_auth returns the proxy
// credentials too (null when the service is IP-only). The endpoints return
// JSON, so these stay jsonResult reads, marked with the factory's standard
// `returnsSecret` SECURITY sentence (same as the kubeconfig tools in k8s.ts).

import { z } from 'zod';
import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';
import { readList, readOne, readTool, defineReadTool, encodeSegment, formatZodError } from './factories.js';

// Shared: an id-scoped detail read on /v1/proxies/{id}{suffix}.
const proxyIdSchema = {
  type: 'object' as const,
  properties: { id: { type: 'string', description: 'Proxy service id from list_proxies.' } },
  required: ['id'],
  additionalProperties: false,
};

// --- fixed reads, no input -------------------------------------------------

export const listProxies = readList(
  'list_proxies',
  '/v1/proxies',
  'List your residential proxy services: id, name, flavor (ISP fixed-IP plan vs GB Residential bandwidth bucket), status, plan, and expiry. Use for "what proxy services do I have?" or to find a proxy service id.',
);

export const getProxyCatalog = readList(
  'get_proxy_catalog',
  '/v1/proxies/catalog',
  'Get the residential proxy catalog for the order wizard: ISP IP-count tiers with EUR + USD pricing per Day/Week/Month, orderable locations, protocol + authentication options, plus a `gb` section of monthly GB Residential bandwidth-bucket tiers (EUR + USD). Use to quote what an ISP plan or a GB bucket costs before recommending or ordering a proxy service. No input.',
);

export const listGbResidentialCountries = readList(
  'list_gb_residential_countries',
  '/v1/proxies/residential/countries',
  'List the countries (id + name) selectable when creating a GB Residential proxy-request. Use to pick a valid country before creating a proxy-request on a GB bucket. GB Residential only: ISP fixed-IP plans do not use this. No input.',
);

export const listGbRotationIntervals = readList(
  'list_gb_rotation_intervals',
  '/v1/proxies/residential/rotation-intervals',
  'List the rotation intervals (id + label: all, high, 1min, 10min, 30min) selectable when creating a GB Residential proxy-request. Use to pick a valid rotation before creating a proxy-request on a GB bucket. GB Residential only: ISP fixed-IP plans do not use this. No input.',
);

// --- single-id detail read -------------------------------------------------

export const getProxy = readOne(
  'get_proxy',
  '/v1/proxies',
  'Get one residential proxy service: flavor (ISP fixed-IP plan vs GB Residential bandwidth bucket), status, plan, location, and expiry/renewal. Use after list_proxies to inspect a single service. The id comes from list_proxies.',
  'id',
  { idSource: 'list_proxies' },
);

// --- per-id sub-path reads -------------------------------------------------

export const getProxyList = readTool({
  name: 'get_proxy_list',
  description:
    'List the live proxy endpoints and credentials (ip, port, username, password) for an active proxy service: this is the direct endpoint list for ISP fixed-IP plans. For a GB Residential bucket the endpoints live under its proxy-requests instead (use list_proxy_requests + get_proxy_request_list). The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  returnsSecret: 'the proxy endpoints with their usernames and passwords',
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/proxy-list`,
});

export const getProxyAuth = readTool({
  name: 'get_proxy_auth',
  description:
    'Get the authentication settings for a proxy service: the auth method, the proxy credentials (null when the service is IP-authenticated only), the IP whitelist, and the caller\'s detected IP. Use to see how the service authenticates before adding a whitelisted IP or switching auth mode. Read-only; change it with set_proxy_auth_method, set_proxy_credentials, add_proxy_whitelisted_ip and remove_proxy_whitelisted_ip. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  returnsSecret: 'the proxy username and password (null for IP-only services)',
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/auth`,
});

export const listProxyRequests = readTool({
  name: 'list_proxy_requests',
  description:
    'List the proxy-requests on a GB Residential bandwidth bucket: the country + rotation-interval + count groups that allocate endpoints from the bucket. Use to see the groups on a GB service or to find a proxy-request id. GB Residential only; ISP fixed-IP plans expose their endpoints directly via get_proxy_list. The id comes from list_proxies (a GB Residential service).',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/proxy-requests`,
});

export const getProxyReplacements = readTool({
  name: 'get_proxy_replacements',
  description:
    'Get the IP-replacement allowance and history for a proxy service: the included monthly allowance (1/month), how much is used, and past replacement requests. Use to check whether a free IP replacement is available before requesting one. Read-only; request one with request_proxy_replacement. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/replacements`,
});

// --- two-param path --------------------------------------------------------
// /v1/proxies/{id}/proxy-requests/{reqId}/proxy-list — inputs named id +
// request_id (per the task brief). Returns live credentials — same secret
// handling as get_proxy_list.

export const getProxyRequestList = readTool({
  name: 'get_proxy_request_list',
  description:
    'List the live proxy endpoints and credentials (ip, port, username, password) for one proxy-request on a GB Residential bucket. Use to fetch the endpoints for a specific country/rotation group; for ISP fixed-IP plans use get_proxy_list instead. The id (a GB Residential service) comes from list_proxies and the request_id from list_proxy_requests.',
  returnsSecret: 'the proxy endpoints with their usernames and passwords',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'GB Residential proxy service id from list_proxies.' },
      request_id: { type: 'string', description: 'Proxy-request id from list_proxy_requests.' },
    },
    required: ['id', 'request_id'],
    additionalProperties: false,
  },
  buildPath: (args) =>
    `/v1/proxies/${encodeSegment(args.id, 'id')}/proxy-requests/${encodeSegment(args.request_id, 'request_id')}/proxy-list`,
});

// --- proxy extras: bandwidth, live check, replacement locations, auto-rotation ---
// Routes confirmed against api/src/routes/v1-proxies.ts and openapi.json:
//   GET  /v1/proxies/{id}/bandwidth               (services:read; GB Residential only)
//   POST /v1/proxies/{id}/check                   (services:read; any kind)
//   GET  /v1/proxies/{id}/replacements/locations  (services:read; ISP only)
//   GET  /v1/proxies/{id}/auto-rotation           (services:read; mobile only)

export const getProxyBandwidth = readTool({
  name: 'get_proxy_bandwidth',
  description:
    'Get the bandwidth usage of a GB Residential bandwidth bucket: unit (e.g. MB), total, used and available. ' +
    'Use to see how much of a GB bucket is left before creating more proxy-requests or ordering a bigger bucket. ' +
    'GB Residential only: ISP and mobile services return an INVALID_PARAM error. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/bandwidth`,
});

// check_proxy: POST /v1/proxies/{id}/check. The API scopes it services:read and
// documents it as a read-only connectivity check (it is exempt from
// Idempotency-Key for that reason), so it is a READ tool: read annotations, no
// confirm gate, no idempotency_key. Its only writes are the API refreshing its
// own display cache (the service's shown location and the per-IP exit geo it
// learns), and for rotating proxies it routes a few hundred bytes through each
// proxy. Hand-written (defineReadTool) because readTool only issues GETs.
const checkProxyInput = z.object({ id: z.string() }).strict();

export const checkProxy: ToolDefinition = defineReadTool({
  name: 'check_proxy',
  description:
    'Run a live check on every proxy of a service: the API routes a small request through each one and reports ' +
    'ip, port, up (true/false), the real exit IP, ISP, city, country, countryCode, latencyMs and routed. Use to ' +
    'confirm a proxy works or to see where it actually exits. Any proxy kind (ISP, GB Residential, mobile). ' +
    'Side effects: it sends a small amount of traffic through each proxy (on GB Residential and mobile this ' +
    'uses a negligible amount of bandwidth), and it refreshes the location the API shows for the service from ' +
    'the exit it finds. It changes nothing else. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  async handler(client, args) {
    const parsed = checkProxyInput.safeParse(args);
    if (!parsed.success) {
      return errorResult(`Invalid input for check_proxy: ${formatZodError(parsed.error)}`);
    }
    try {
      return jsonResult(await client.post(`/v1/proxies/${encodeSegment(parsed.data.id, 'id')}/check`));
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
});

export const listProxyReplacementLocations = readTool({
  name: 'list_proxy_replacement_locations',
  description:
    'List the locations (id + label) a new IP can be placed in when replacing an IP of an ISP proxy service. ' +
    'This set comes from the proxy provider and differs from the order catalog locations in get_proxy_catalog. ' +
    'ISP proxy services only. Check get_proxy_replacements first for the monthly allowance. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/replacements/locations`,
});

export const getProxyAutoRotation = readTool({
  name: 'get_proxy_auto_rotation',
  description:
    'Get the auto-rotation settings of a mobile proxy line: enabled and intervalMinutes (how often the exit IP ' +
    'changes on its own). Mobile proxy lines only (mobile-4g, mobile-vpn, mobile-multisim); other kinds return an ' +
    'error. Read-only; change it with set_proxy_auto_rotation, or rotate now with rotate_proxy. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/auto-rotation`,
});
