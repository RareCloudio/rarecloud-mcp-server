// Residential-proxy tools — read-only views of the legacy residential-proxy
// product. Two flavors: ISP (fixed IP-count plans whose endpoints are listed
// directly) and GB Residential (bandwidth buckets on which you create
// "proxy-requests" — country + rotation-interval groups that allocate
// endpoints). Reads here cover: the service list/detail, the live proxy list,
// auth settings, GB metadata (countries, rotation intervals), the
// proxy-requests list + their per-request proxy lists, and the replacement
// allowance. Read-only by design (same as the rest of this server); ordering,
// renewing, cancelling, and changing auth/whitelist are writes not exposed here.
//
// get_proxy_list and get_proxy_request_list return LIVE proxy credentials
// (ip, port, username, password), and get_proxy_auth returns the proxy
// credentials too (null when the service is IP-only). The endpoints return
// JSON, so these stay jsonResult reads — but their descriptions carry the same
// treat-as-secret guidance as the kubeconfig tools (see k8s.ts): do not echo
// the result back to the user unless explicitly asked.

import { readList, readOne, readTool, encodeSegment } from './factories.js';

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
  'List the countries (id + name) selectable when creating a GB Residential proxy-request. Use to pick a valid country before creating a proxy-request on a GB bucket. GB Residential only — ISP fixed-IP plans do not use this. No input.',
);

export const listGbRotationIntervals = readList(
  'list_gb_rotation_intervals',
  '/v1/proxies/residential/rotation-intervals',
  'List the rotation intervals (id + label: all, high, 1min, 10min, 30min) selectable when creating a GB Residential proxy-request. Use to pick a valid rotation before creating a proxy-request on a GB bucket. GB Residential only — ISP fixed-IP plans do not use this. No input.',
);

// --- single-id detail read -------------------------------------------------

export const getProxy = readOne(
  'get_proxy',
  '/v1/proxies',
  'Get one residential proxy service: flavor (ISP fixed-IP plan vs GB Residential bandwidth bucket), status, plan, location, and expiry/renewal. Use after list_proxies to inspect a single service. The id comes from list_proxies.',
);

// --- per-id sub-path reads -------------------------------------------------

export const getProxyList = readTool({
  name: 'get_proxy_list',
  description:
    'List the live proxy endpoints and credentials (ip, port, username, password) for an active proxy service — this is the direct endpoint list for ISP fixed-IP plans. For a GB Residential bucket the endpoints live under its proxy-requests instead (use list_proxy_requests + get_proxy_request_list). SECURITY: the result contains LIVE CREDENTIALS — usernames and passwords that grant use of the proxies. Treat it as a secret: do NOT echo it back to the user or repeat its contents unless the user explicitly asks to see it; pass it straight to the tool that consumes it. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/proxy-list`,
});

export const getProxyAuth = readTool({
  name: 'get_proxy_auth',
  description:
    'Get the authentication settings for a proxy service: the auth method, the proxy credentials (null when the service is IP-authenticated only), the IP whitelist, and the caller\'s detected IP. Use to see how the service authenticates before adding a whitelisted IP or switching auth mode. SECURITY: the result may contain LIVE CREDENTIALS — the proxy username and password (null for IP-only services). Treat it as a secret: do NOT echo it back to the user or repeat its contents unless the user explicitly asks to see it; pass it straight to the tool that consumes it. Read-only; changing the auth method / credentials / whitelist are writes and are not exposed as MCP tools yet. The id comes from list_proxies.',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/auth`,
});

export const listProxyRequests = readTool({
  name: 'list_proxy_requests',
  description:
    'List the proxy-requests on a GB Residential bandwidth bucket — the country + rotation-interval + count groups that allocate endpoints from the bucket. Use to see the groups on a GB service or to find a proxy-request id. GB Residential only; ISP fixed-IP plans expose their endpoints directly via get_proxy_list. The id comes from list_proxies (a GB Residential service).',
  inputSchema: proxyIdSchema,
  buildPath: (args) => `/v1/proxies/${encodeSegment(args.id, 'id')}/proxy-requests`,
});

export const getProxyReplacements = readTool({
  name: 'get_proxy_replacements',
  description:
    'Get the IP-replacement allowance and history for a proxy service: the included monthly allowance (1/month), how much is used, and past replacement requests. Use to check whether a free IP replacement is available before requesting one. Read-only; requesting a replacement is a write and is not exposed as an MCP tool yet. The id comes from list_proxies.',
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
    'List the live proxy endpoints and credentials (ip, port, username, password) for one proxy-request on a GB Residential bucket. Use to fetch the endpoints for a specific country/rotation group; for ISP fixed-IP plans use get_proxy_list instead. SECURITY: the result contains LIVE CREDENTIALS — usernames and passwords that grant use of the proxies. Treat it as a secret: do NOT echo it back to the user or repeat its contents unless the user explicitly asks to see it; pass it straight to the tool that consumes it. The id (a GB Residential service) comes from list_proxies and the request_id from list_proxy_requests.',
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
