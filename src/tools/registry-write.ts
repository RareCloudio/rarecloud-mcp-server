// Container Registry WRITE tools: the mutating twin of registry.ts. Enable /
// change tier / close the account, mint/revoke robot credentials, delete
// repositories/tags, and link/unlink/rotate Kubernetes cluster access. All
// build on the shared `writeTool` factory so input validation, the confirm
// gate, `encodeSegment` path encoding, and the APIError -> errorResult
// mapping stay uniform with the other *-write.ts modules. All scope
// services:write; there is no separate registry scope (same sharing
// `services:write` already does for proxies/k8s/infra; see index.test.ts's
// exclusion-guard comment).
//
// POLICY RULING (binding, recorded here per the task instruction).
// This repo's security policy excludes account IDENTITY credentials
// (password, 2FA, sub-user invites, affiliate activate/withdraw; see
// account-write.ts's header and the FORBIDDEN_TOOL_NAMES list in
// index.test.ts). Registry ROBOT credentials (docker login / pull / push,
// registry_credentials_create/_revoke) and the BYO Kubernetes manifest
// (registry_kubernetes_manifest, which also mints one) are a DIFFERENT
// class: infrastructure ACCESS material, the same category as
// add_account_ssh_key / create_cluster_kubeconfig, not identity. Spec CR-12
// explicitly allows them behind an agent PAT, gated by `confirm: true`, with
// the minted secret shown exactly once and a warning that it cannot be
// retrieved again. This does not relax the identity exclusion above; it
// only confirms robot/infra credentials were never part of it. See
// index.test.ts for the registry-scoped extension of the exclusion guard
// that pins this in a test.
//
// Bodies + bounds re-confirmed against console openapi.json (Registry tag)
// AND the route sources (api/src/routes/v1-registry.ts,
// v1-registry-repos.ts, v1-registry-clusters.ts, v1-registry-byo.ts).
// DEVIATIONS / notable choices over a bare reading of the brief:
//
//   - registry_enable: `handle` mirrors the route's `^[a-z0-9]{3,30}$`
//     (3-30 lowercase letters/digits) in both zod and the JSON inputSchema.
//     Plain write (no confirm), matching the brief: enabling/reopening/
//     re-enabling is reversible (registry_close is the gated, destructive
//     direction) and never spends money by itself (a tier's price is billed
//     over time, not charged synchronously here).
//   - registry_set_tier: plain write (no confirm). An upgrade always
//     succeeds, and a downgrade is refused server-side (tier_below_usage)
//     rather than silently losing data, so there is nothing irreversible
//     for a client-side gate to protect against.
//   - registry_close: the API itself requires `?confirm=<handle>`, a
//     SEPARATE, second confirmation layer from this tool's own `confirm:
//     true` gate. `handle` is therefore a real domain input (the account's
//     own handle, to be typed back), not a boolean; it is placed in the
//     query string via URLSearchParams (which percent-encodes the whole
//     value), so no encodeSegment traversal guard applies or is needed here.
//     A query value can never alter the URL's path structure.
//   - registry_credentials_create: `name` mirrors the route's
//     `^[a-z0-9][a-z0-9-]{1,30}$` (2-31 chars). REQUIRES confirm:true per
//     CR-12 even though creating a credential is not itself destructive;
//     the gate exists because the result carries a live secret. NOT
//     destructiveHint (nothing is torn down). formatResult
//     (withSecretWarning) appends a one-line, non-repeating warning after
//     the JSON so the secret is never rendered a second time within the
//     same result.
//   - registry_credentials_revoke: `id` mirrors the route's
//     `z.string().uuid()` / openapi `format: uuid`, TIGHTER than the loose
//     `.min(1)` k8s-write.ts uses for its own credential_id, because this
//     one has a known, stable uuid format to mirror. Consequence: a ".."
//     (or any non-uuid) value is rejected by the ZOD layer ("Invalid input
//     for registry_credentials_revoke: id: Invalid uuid"), never reaching
//     encodeSegment's own traversal check. encodeSegment is still applied
//     when building the path, for defense-in-depth and convention
//     consistency, but its own `.`/`..`/empty rejection branch is
//     unreachable for this particular tool given the upstream uuid gate.
//   - registry_repository_delete / registry_tag_delete: `repo` stays a loose
//     `z.string().min(1)` (no independently-known length bound, see
//     registry.ts's header) so a traversal token DOES reach encodeSegment
//     and is rejected there. `tag` mirrors the route's exported
//     `TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/` (tokenService.ts).
//     Note this regex's first-character class excludes `.`, so a
//     `tag: '..'` is ALSO rejected at the zod layer (like credential id
//     above), not by encodeSegment.
//   - registry_cluster_link: deliberately a PLAIN write (no confirm, no
//     destructiveHint) despite installing a controller with real cluster-
//     wide permissions. The full CR-7 blast-radius disclosure is returned
//     VERBATIM in every success response (`disclosure`), and the
//     description below instructs relaying it to the user unedited. The
//     reverse operation (registry_cluster_unlink) IS gated, so an
//     unapproved link is always cheaply undoable.
//   - registry_cluster_rotate: confirm, but NOT destructiveHint: nothing is
//     torn down (the old credential is retired only once the new one is
//     confirmed working), and the response never carries a secret (the new
//     credential is installed directly into the cluster, never returned to
//     the caller).
//   - registry_kubernetes_manifest: query parameters (scope/expiry/
//     namespace/secretName), not a body, mirroring the route's
//     `QuerySchema`. `namespace`/`secretName` mirror the route's exported
//     DNS-1123 label rule (`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, max 63).
//     REQUIRES confirm:true (mints a credential, same as
//     registry_credentials_create). Sends `Accept: application/json` via
//     the factory's new `extraHeaders` option: the endpoint's DEFAULT
//     response is a raw `application/yaml` Secret manifest for a plain
//     `curl | kubectl apply -f -` flow, and only answers with the
//     structured `{credential,manifest,secret}` envelope this tool parses
//     when that header is present (mirrors the CLI's own `DoAccept`
//     addition for the identical need). Same withSecretWarning treatment as
//     registry_credentials_create.

import { z } from 'zod';
import { type ToolCallResult, type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

const REGISTRY_TIERS = ['free', 'starter', 'premium', 'enterprise'] as const;

const HANDLE_RE = /^[a-z0-9]{3,30}$/;
const CREDENTIAL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const DNS_1123_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// CR-12: the minted secret is shown exactly once, right here. Appended after
// the JSON payload (which already contains it once) rather than folded into
// jsonResult, so the secret's single appearance is easy to verify in tests
// and the warning reads as a distinct, non-repeating line.
const SECRET_WARNING =
  'WARNING: the secret above is shown ONLY in this response and can never be retrieved again. ' +
  'Save or relay it now. Do not display it again after this turn, and never write it to a log.';

function withSecretWarning(data: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: `${JSON.stringify(data, null, 2)}\n\n${SECRET_WARNING}` }] };
}

// --- registry_enable (POST /registry, no gate) ------------------------------

export const registryEnable: ToolDefinition = writeTool({
  name: 'registry_enable',
  description:
    'Enable the account\'s private container registry, or reopen/re-enable a previously closed one. ' +
    'Requires scope services:write. Plain write, not gated. handle: 3-30 lowercase letters/digits, ' +
    'IMMUTABLE once set, becomes the image path prefix (`<hostname>/<handle>/<repo>`), EXCEPT when ' +
    're-enabling an account that was closed AND whose grace window has fully elapsed (storage already ' +
    'purged), where a different, currently-free handle may be supplied instead. tier: free, starter, ' +
    'premium, or enterprise; see registry_tiers to compare quotas/pricing first. If the account was ' +
    'closed via registry_close and is STILL inside its grace window, calling this again with the SAME ' +
    'handle REOPENS it (200, storage was never deleted). If the grace window elapsed, calling this ' +
    'RE-ENABLES it (200): the same handle is reclaimed, or a different free one may be used. Fails with ' +
    'handle_taken if the handle is already in use by another account, or a conflict if this account is ' +
    'already enabled or is suspended.',
  method: 'POST',
  input: z
    .object({
      handle: z.string().regex(HANDLE_RE, 'handle must be 3-30 lowercase letters/digits.'),
      tier: z.enum(REGISTRY_TIERS),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        pattern: HANDLE_RE.source,
        description:
          '3-30 lowercase letters/digits. Immutable once set (except re-enabling a closed-and-purged ' +
          'account onto a different, currently-free handle). Becomes the image path prefix.',
      },
      tier: {
        type: 'string',
        enum: [...REGISTRY_TIERS],
        description: 'Billing tier. See registry_tiers for quotas and pricing.',
      },
    },
    required: ['handle', 'tier'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/registry',
  buildBody: (a) => ({ handle: a.handle, tier: a.tier }),
});

// --- registry_set_tier (PATCH /registry, no gate) --------------------------

export const registrySetTier: ToolDefinition = writeTool({
  name: 'registry_set_tier',
  description:
    'Change the billing tier of the account\'s container registry. Requires scope services:write. Plain ' +
    'write, not gated. Same tier as today is a no-op (200, nothing changes). An UPGRADE (new tier\'s ' +
    'quota >= current) is always allowed and effective immediately. A DOWNGRADE is allowed only when the ' +
    'account has never been measured yet, or its latest usage sample is at or under the NEW tier\'s quota. ' +
    'Otherwise it is refused (error.details message tier_below_usage) so storage can never be downgraded ' +
    'out from under itself. Also refused if the registry is closed (account_closed). Use registry_tiers ' +
    'to compare quotas before choosing, and registry_get to check current usage.',
  method: 'PATCH',
  input: z.object({ tier: z.enum(REGISTRY_TIERS) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      tier: { type: 'string', enum: [...REGISTRY_TIERS], description: 'The new billing tier.' },
    },
    required: ['tier'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/registry',
  buildBody: (a) => ({ tier: a.tier }),
});

// --- registry_close (DELETE /registry?confirm=<handle>, confirm+destr) -----

export const registryClose: ToolDefinition = writeTool({
  name: 'registry_close',
  description:
    'Close the account\'s container registry. Requires scope services:write. DESTRUCTIVE: schedules the ' +
    'registry\'s storage for permanent deletion, but NOT immediately. The account stays reopenable with ' +
    'the SAME handle (registry_enable) until the returned deleteAfter time, after which an hourly job ' +
    'purges it for good. While closed, no other mutation is accepted except reopening. The API separately ' +
    'requires the account\'s OWN handle (from registry_get) as an explicit typed confirmation, passed here ' +
    'as `handle`. This is IN ADDITION to this tool\'s own confirm:true gate; both are required. Refused if ' +
    'already closed (account_closed) or suspended (account_suspended; contact support instead). Pass ' +
    'confirm:true and the exact handle only after the user has explicitly approved closing the registry.',
  method: 'DELETE',
  input: z.object({ handle: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        minLength: 1,
        description: 'The registry\'s own handle (from registry_get), typed to confirm. Must equal it exactly.',
      },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry?${new URLSearchParams({ confirm: String(a.handle) }).toString()}`,
  confirm: true,
  destructiveHint: true,
});

// --- registry_credentials_create (POST /registry/credentials, confirm) -----

export const registryCredentialsCreate: ToolDefinition = writeTool({
  name: 'registry_credentials_create',
  description:
    'Create a robot credential for `docker login` / pull / push against the account\'s container registry. ' +
    'Requires scope services:write. REQUIRES confirm:true (CR-12: this mints a real, live secret). Pass ' +
    'it only after the user has explicitly approved. name is your label for the credential and also half ' +
    'of the login username, `<handle>+<name>` (2-31 chars: lowercase letters/digits/hyphens, must start ' +
    'with a letter or digit). scope is pull (read-only) or push (read-write). expiresAt is an optional ISO ' +
    '8601 timestamp in the future; omit for a credential that never expires. Fails with credential_limit ' +
    'if the account already holds the maximum number of non-revoked credentials; revoke an unused one ' +
    'with registry_credentials_revoke first. SECURITY: the result includes the secret, the docker login ' +
    'password, exactly ONCE, in this response; it is never shown again and can never be retrieved. Save ' +
    'or relay it immediately; do not display it again after this turn or write it to a log.',
  method: 'POST',
  input: z
    .object({
      name: z
        .string()
        .regex(CREDENTIAL_NAME_RE, 'name must be 2-31 chars: lowercase letters/digits/hyphens, starting with a letter or digit.'),
      scope: z.enum(['pull', 'push']),
      expiresAt: z.string().datetime().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        pattern: CREDENTIAL_NAME_RE.source,
        description: 'Your label for the credential; also half of the login username, `<handle>+<name>`.',
      },
      scope: { type: 'string', enum: ['pull', 'push'], description: 'pull (read-only) or push (read-write).' },
      expiresAt: {
        type: 'string',
        format: 'date-time',
        description: 'Optional expiry (ISO 8601, must be in the future). Omit for a credential that never expires.',
      },
    },
    required: ['name', 'scope'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/registry/credentials',
  buildBody: (a) => {
    const body: Record<string, unknown> = { name: a.name, scope: a.scope };
    if (a.expiresAt !== undefined) body.expiresAt = a.expiresAt;
    return body;
  },
  confirm: true,
  formatResult: withSecretWarning,
});

// --- registry_credentials_revoke (DELETE /registry/credentials/{id}, confirm+destr) --

export const registryCredentialsRevoke: ToolDefinition = writeTool({
  name: 'registry_credentials_revoke',
  description:
    'Revoke a container registry robot credential immediately. Requires scope services:write. ' +
    'DESTRUCTIVE and irreversible: it stops authenticating right away; any docker login/pull/push using ' +
    'it starts failing at once. Mint a replacement with registry_credentials_create if needed. Pass ' +
    'confirm:true only after the user has explicitly approved. id (a uuid) comes from ' +
    'registry_credentials_list.',
  method: 'DELETE',
  input: z.object({ id: z.string().uuid() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Credential id from registry_credentials_list.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/credentials/${encodeSegment(a.id, 'id')}`,
  confirm: true,
  destructiveHint: true,
});

// --- registry_repository_delete (DELETE /registry/repositories/{repo}, confirm+destr) --

export const registryRepositoryDelete: ToolDefinition = writeTool({
  name: 'registry_repository_delete',
  description:
    'Delete an entire repository from the account\'s container registry. Requires scope services:write. ' +
    'DESTRUCTIVE and irreversible: deletes every distinct image (manifest digest) in the repository; ' +
    'every tag that pointed at any of them stops resolving. repo may itself contain `/` (e.g. `team/app`) ' +
    'and is always resolved under the account\'s own handle. Fails with a not-found if the repository has ' +
    'no tags at all (unlike registry_repository_get, an empty repository is treated as nothing to delete ' +
    'here). Pass confirm:true only after the user has explicitly approved. repo comes from ' +
    'registry_repositories_list.',
  method: 'DELETE',
  input: z.object({ repo: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        minLength: 1,
        description: 'Repository path relative to the account\'s handle (may contain /). From registry_repositories_list.',
      },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/repositories/${encodeSegment(a.repo, 'repo')}`,
  confirm: true,
  destructiveHint: true,
});

// --- registry_tag_delete (DELETE /registry/repositories/{repo}/tags/{tag}, confirm+destr) --

export const registryTagDelete: ToolDefinition = writeTool({
  name: 'registry_tag_delete',
  description:
    'Delete one tag from a repository in the account\'s container registry. Requires scope ' +
    'services:write. DESTRUCTIVE: removes ONLY this tag reference. The underlying manifest, and any ' +
    'OTHER tag still pointing at the same digest, is untouched (use registry_repository_delete to remove ' +
    'everything in a repository). Pass confirm:true only after the user has explicitly approved. repo + ' +
    'tag come from registry_repository_get.',
  method: 'DELETE',
  input: z
    .object({
      repo: z.string().min(1),
      tag: z.string().regex(TAG_RE, 'tag must be a valid OCI tag (up to 128 chars).'),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', minLength: 1, description: 'Repository path relative to the account\'s handle (may contain /).' },
      tag: {
        type: 'string',
        pattern: TAG_RE.source,
        maxLength: 128,
        description: 'The tag to delete, from registry_repository_get.',
      },
    },
    required: ['repo', 'tag'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/repositories/${encodeSegment(a.repo, 'repo')}/tags/${encodeSegment(a.tag, 'tag')}`,
  confirm: true,
  destructiveHint: true,
});

// --- registry_cluster_link (POST /registry/clusters/{serviceId}, no gate) --

export const registryClusterLink: ToolDefinition = writeTool({
  name: 'registry_cluster_link',
  description:
    'Link one of the account\'s OWN Kubernetes clusters to its container registry. Requires scope ' +
    'services:write. Ownership is checked server-side: a foreign or unknown service_id 404s, never ' +
    'trusted from the argument alone. Mints a dedicated pull credential and installs a small controller ' +
    '(the RareCloud registry secret-syncer) in the cluster, so every namespace, present and future, can ' +
    'pull from the registry without copying a secret by hand. IMPORTANT: this installs a controller with ' +
    'real, cluster-wide permissions. The result\'s `disclosure` field states EXACTLY what it can read and ' +
    'write; relay that text to the user VERBATIM (do not paraphrase, shorten, or omit it), ideally before ' +
    'calling this on their behalf. A cluster that is not reachable yet (still provisioning) is not an ' +
    'error: the link is recorded with status "linking" and finishes automatically once the cluster becomes ' +
    'reachable. Fails with already_linked if this cluster is already linked. service_id comes from ' +
    'list_services (a cloud-k8s service); undo with registry_cluster_unlink.',
  method: 'POST',
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Managed-Kubernetes service id from list_services.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/clusters/${encodeSegment(a.service_id, 'service_id')}`,
});

// --- registry_cluster_unlink (DELETE /registry/clusters/{serviceId}, confirm+destr) --

export const registryClusterUnlink: ToolDefinition = writeTool({
  name: 'registry_cluster_unlink',
  description:
    'Unlink a Kubernetes cluster from the account\'s container registry. Requires scope services:write. ' +
    'DESTRUCTIVE: removes everything registry_cluster_link installed (the secret-syncer, every ' +
    'namespace\'s copy of the pull secret, patched ServiceAccounts, the RBAC objects) and revokes the pull ' +
    'credential. Link again with registry_cluster_link if access is needed later. A cluster that is ' +
    'unreachable at call time stays "unlinking" and the hourly reconciler finishes the teardown; calling ' +
    'this again on a cluster already mid-unlink is a no-op, not an error. Pass confirm:true only after the ' +
    'user has explicitly approved. service_id comes from registry_clusters_list.',
  method: 'DELETE',
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Managed-Kubernetes service id from registry_clusters_list.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/clusters/${encodeSegment(a.service_id, 'service_id')}`,
  confirm: true,
  destructiveHint: true,
});

// --- registry_cluster_rotate (POST /registry/clusters/{serviceId}/rotate, confirm) --

export const registryClusterRotate: ToolDefinition = writeTool({
  name: 'registry_cluster_rotate',
  description:
    'Rotate a linked cluster\'s registry pull credential. Requires scope services:write. Mints a fresh ' +
    'credential, pushes it into the cluster, and only revokes the OLD one once every namespace\'s copy has ' +
    'caught up, so the cluster never has a moment with no working credential. If propagation has not ' +
    'finished by the time this call returns, the response is status "rotating" and BOTH credentials stay ' +
    'live until the hourly reconciler confirms and finishes the swap. Fails with rotation_in_progress if a ' +
    'rotation is already in flight for this cluster. Does NOT return a secret: the new credential is ' +
    'installed directly into the cluster, never shown here. Pass confirm:true only after the user has ' +
    'explicitly approved. service_id comes from registry_clusters_list.',
  method: 'POST',
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Managed-Kubernetes service id from registry_clusters_list.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/clusters/${encodeSegment(a.service_id, 'service_id')}/rotate`,
  confirm: true,
});

// --- registry_kubernetes_manifest (POST /registry/docker-credentials/kubernetes, confirm) --

export const registryKubernetesManifest: ToolDefinition = writeTool({
  name: 'registry_kubernetes_manifest',
  description:
    'Get a ready-to-apply pull-secret manifest for a Kubernetes cluster the account manages ITSELF (BYO: ' +
    'a kind/EKS/GKE/bare-metal cluster RareCloud does not run). The secret-syncer (registry_cluster_link) ' +
    'only installs where the api has direct cluster access, which a cluster RareCloud does not run never ' +
    'has. Requires scope services:write. Mints a NEW pull (or push) credential every call and returns it ' +
    'plus a Kubernetes Secret manifest (`type: kubernetes.io/dockerconfigjson`) ready for `kubectl apply ' +
    '-f`. REQUIRES confirm:true (mints a real, live secret). Pass it only after the user has explicitly ' +
    'approved. scope (default pull), expiry (30d, 90d, 1y, or never; default 30d), namespace and ' +
    'secretName (DNS-1123 labels; default "default" / "rarecloud-registry") are all optional. Counts ' +
    'against the account\'s credential cap: fails with credential_limit once reached. SECURITY: the ' +
    'result includes the secret exactly ONCE, embedded in both the manifest text and a separate `secret` ' +
    'field; it is never shown again and can never be retrieved. Save or relay it immediately; do not ' +
    'display it again after this turn or write it to a log.',
  method: 'POST',
  input: z
    .object({
      scope: z.enum(['pull', 'push']).optional(),
      expiry: z.enum(['30d', '90d', '1y', 'never']).optional(),
      namespace: z.string().max(63).regex(DNS_1123_LABEL_RE, 'namespace must be a valid DNS-1123 label.').optional(),
      secretName: z.string().max(63).regex(DNS_1123_LABEL_RE, 'secretName must be a valid DNS-1123 label.').optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['pull', 'push'], description: 'pull (default) or push.' },
      expiry: { type: 'string', enum: ['30d', '90d', '1y', 'never'], description: 'Credential lifetime (default 30d).' },
      namespace: {
        type: 'string',
        maxLength: 63,
        pattern: DNS_1123_LABEL_RE.source,
        description: 'The namespace the manifest targets; must be a valid DNS-1123 label (default "default").',
      },
      secretName: {
        type: 'string',
        maxLength: 63,
        pattern: DNS_1123_LABEL_RE.source,
        description: 'The Secret\'s name in the manifest; must be a valid DNS-1123 label (default "rarecloud-registry").',
      },
    },
    required: [],
    additionalProperties: false,
  },
  buildPath: (a) => {
    const q = new URLSearchParams();
    if (a.scope !== undefined) q.set('scope', a.scope);
    if (a.expiry !== undefined) q.set('expiry', a.expiry);
    if (a.namespace !== undefined) q.set('namespace', a.namespace);
    if (a.secretName !== undefined) q.set('secretName', a.secretName);
    const s = q.toString();
    return s ? `/v1/registry/docker-credentials/kubernetes?${s}` : '/v1/registry/docker-credentials/kubernetes';
  },
  confirm: true,
  extraHeaders: { Accept: 'application/json' },
  formatResult: withSecretWarning,
});
