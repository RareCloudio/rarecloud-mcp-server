// Container Registry READ tools: wrap the account's own private OCI
// container registry, covering account status/usage/quota, billing tiers,
// robot credentials (metadata only, never a secret; see registry-write.ts
// for creation), repositories/tags/CVE findings, and linked Kubernetes
// clusters. Read-only by design (same convention as every other *.ts read
// file here); the matching mutations live in registry-write.ts.
//
// No read tool below names a scope literal in its description, matching
// this repo's existing convention for every other read tool (only writes
// name their exact `{domain}:write` scope; see factories.ts / README.md
// "Configure"). The registry's reads sit under `services:read`, the same
// scope the Kubernetes/proxies/infra reads already use: there is no
// separate registry scope, exactly like proxies share `services:write` on
// the write side (see index.test.ts's exclusion-guard comment).
//
// Bodies + shapes re-confirmed against console openapi.json (the Registry
// tag) AND the route sources (api/src/routes/v1-registry.ts,
// v1-registry-repos.ts, v1-registry-clusters.ts):
//
//   - registry_tiers (GET /registry/tiers): this endpoint is being added in
//     PARALLEL by a concurrent task on the same effort and does not exist yet
//     on the route sources this file was written against. Modeled directly
//     from the ruled response shape handed down for this task:
//     `{items: [{tier, quotaGb, burstCeilingGb, monthlyCents: {EUR, USD},
//     overageCentsPerGbMonth, available}]}`. No input, matching the
//     catalog.ts convention for un-authed/no-argument "what are my options"
//     reads (list_catalog_products, list_regions, ...).
//   - registry_repository_get / registry_repository_vulnerabilities: `repo`
//     MAY itself contain `/` (e.g. `team/app`); the API always resolves it
//     under the caller's own handle and never trusts it as a full name. This
//     is passed through `encodeSegment`, which is safe for a multi-segment
//     value: it percent-encodes the WHOLE argument into one opaque path
//     segment (any internal `/` becomes `%2F`), which the route's own
//     `repoPathSegments` decodes back into the original multi-part string.
//     Verified empirically against Node's URL parser: a literal `..` is
//     rejected by encodeSegment itself before any request, and an embedded
//     `a/../b` never reaches URL dot-segment normalization because it never
//     appears as a literal, unescaped path segment. See v1-registry-repos.ts's
//     own header comment for the matching server-side reasoning (the
//     "sub-resource dispatch rule": a repository whose OWN name ends exactly
//     like `tags/<tag>` or `tags/<tag>/vulnerabilities` cannot be addressed
//     by these routes, inherent to allowing `/` in repository names, not a
//     defect in this client).
//   - `repo` has no independently-known client-side length bound. Its real
//     ceiling, `MAX_REPOSITORY_NAME_LENGTH` = 255, is shared with the
//     account's own handle inside the combined `${handle}/${path}` name, so
//     a fixed bound here could wrongly reject a valid short repo under a
//     long handle. It is left as `minLength: 1`; the server is authoritative.
//   - registry_repositories_list / registry_repository_vulnerabilities page
//     with `limit` (1-100, default 50) + `cursor` (opaque, from a previous
//     page's `nextCursor`), the same optional-query-params idiom as
//     account.ts's get_account_activity / list_account_emails.

import { readList, readTool, encodeSegment } from './factories.js';

export const registryGet = readList(
  'registry_get',
  '/v1/registry',
  'Get the authenticated account\'s container registry: handle, hostname, tier, status, live usage sample ' +
    '(logicalBytes/repoCount/sampledAt, null until first measured), current quota/burst ceiling, whether a ' +
    '`docker push` is currently allowed right now (and why not, if not), and how many owned Kubernetes ' +
    'clusters are linked (vs linkable). 404 if the registry has not been enabled yet; use registry_enable ' +
    'first. Use for "is my registry set up?", "how much am I storing?", or "can I still push?".',
);

export const registryTiers = readList(
  'registry_tiers',
  '/v1/registry/tiers',
  'List the container registry\'s billing tiers: for each tier, its included storage quota (decimal GB), ' +
    'burst ceiling (quota multiplied by the tier\'s burst multiplier; the free tier never bursts), monthly ' +
    'price in EUR/USD cents, overage price per GB-month above quota, and whether the tier is currently ' +
    'available to select. No input. Use before registry_enable to choose a starting tier, or before ' +
    'registry_set_tier to compare options.',
);

export const registryCredentialsList = readList(
  'registry_credentials_list',
  '/v1/registry/credentials',
  'List the account\'s container registry robot credentials (for `docker login` / pull / push): id, name, ' +
    'scope, username (`<handle>+<name>`), expiresAt, createdAt, lastUsedAt, revokedAt. NEVER includes a ' +
    'secret. A credential\'s secret is only ever shown once, at creation (registry_credentials_create). Use ' +
    'to find a credential id for registry_credentials_revoke, or to audit what exists.',
);

export const registryRepositoriesList = readTool({
  name: 'registry_repositories_list',
  description:
    'List the repositories under the account\'s own registry handle: name, path, sizeBytes, lastPush, ' +
    'newestTag. The `path` returned here NEVER carries the handle; pass it straight to ' +
    'registry_repository_get / registry_repository_delete / registry_tag_delete / ' +
    'registry_repository_vulnerabilities as `repo`. Page with limit (1-100, default 50) and cursor (from a ' +
    'previous page\'s nextCursor). 404 if the registry is not enabled yet.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size, clamped to 1-100 (default 50).' },
      cursor: { type: 'string', description: 'Opaque pagination cursor from a previous page\'s nextCursor.' },
    },
    additionalProperties: false,
  },
  buildPath: (args) => {
    const q = new URLSearchParams();
    if (args.limit !== undefined) q.set('limit', String(args.limit));
    if (args.cursor !== undefined && args.cursor !== '') q.set('cursor', String(args.cursor));
    const s = q.toString();
    return s ? `/v1/registry/repositories?${s}` : '/v1/registry/repositories';
  },
});

export const registryRepositoryGet = readTool({
  name: 'registry_repository_get',
  description:
    'Get one repository\'s full tag list, each tag with its own CVE severity counts (critical/high/medium/' +
    'low/unknown, plus an `unavailable` flag if the scan itself could not be read). repo is relative to the ' +
    'account\'s own handle and may contain `/` (e.g. `team/app`); it is always resolved under that handle, ' +
    'never anyone else\'s. A malformed or foreign-shaped value 404s the same way whether or not it exists ' +
    'elsewhere, so a namespace probe learns nothing. An empty tags array means the repository does not ' +
    'exist, or exists but currently holds no images; both read the same way. repo comes from ' +
    'registry_repositories_list.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', minLength: 1, description: 'Repository path relative to the account\'s handle (may contain /). From registry_repositories_list.' },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/registry/repositories/${encodeSegment(args.repo, 'repo')}`,
});

export const registryRepositoryVulnerabilities = readTool({
  name: 'registry_repository_vulnerabilities',
  description:
    'List paginated CVE findings (from the registry\'s vulnerability scan) for one tag of one repository: ' +
    'id, severity, title, affected packages. `unavailable: true` means the scan extension itself is ' +
    'disabled or unreachable: items is empty, NOT a real "no findings" answer; do not report a clean scan ' +
    'in that case. An unknown tag also returns an empty items list (no separate "tag not found" signal). ' +
    'Page with limit (1-100, default 50) and cursor (from a previous page\'s nextCursor). repo + tag come ' +
    'from registry_repository_get.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', minLength: 1, description: 'Repository path relative to the account\'s handle (may contain /).' },
      tag: { type: 'string', minLength: 1, description: 'The tag to scan, from registry_repository_get.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size, clamped to 1-100 (default 50).' },
      cursor: { type: 'string', description: 'Opaque pagination cursor from a previous page\'s nextCursor.' },
    },
    required: ['repo', 'tag'],
    additionalProperties: false,
  },
  buildPath: (args) => {
    const base =
      `/v1/registry/repositories/${encodeSegment(args.repo, 'repo')}` +
      `/tags/${encodeSegment(args.tag, 'tag')}/vulnerabilities`;
    const q = new URLSearchParams();
    if (args.limit !== undefined) q.set('limit', String(args.limit));
    if (args.cursor !== undefined && args.cursor !== '') q.set('cursor', String(args.cursor));
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  },
});

export const registryClustersList = readList(
  'registry_clusters_list',
  '/v1/registry/clusters',
  'List the Kubernetes clusters linked to the account\'s container registry: serviceId, clusterName, ' +
    'status (linking/active/rotating/unlinking/error), installedAt, syncerImage, syncerReady, ' +
    'syncerCheckedAt, lastError. A link whose cluster can no longer be found reports status "error" with ' +
    'lastError "cluster not found" rather than disappearing silently. Use to find a service_id for ' +
    'registry_cluster_unlink / registry_cluster_rotate, or to check whether linking finished (status ' +
    '"linking" means it is still in progress).',
);
