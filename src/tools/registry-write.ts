// Container Registry WRITE tools: the mutating twin of registry.ts. Enable /
// change tier / close the account, mint/revoke robot credentials, delete
// repositories/tags/manifests, and link/unlink/rotate Kubernetes cluster access. All
// build on the shared `writeTool` factory so input validation, the confirm
// gate, `encodeSegment` path encoding, and the APIError -> errorResult
// mapping stay uniform with the other *-write.ts modules. All scope
// services:write; there is no separate registry scope (same sharing
// `services:write` already does for proxies/k8s/infra; see index.test.ts's
// exclusion-guard comment).
//
// POLICY RULING (binding). This repo's security policy excludes account
// IDENTITY credentials (password, 2FA, sub-user invites, affiliate
// activate/withdraw; see account-write.ts's header and FORBIDDEN_TOOL_NAMES
// in index.test.ts). Registry ROBOT credentials (create_registry_credential
// / revoke_registry_credential) and the BYO Kubernetes manifest (create_registry_kubernetes_manifest,
// which also mints one) are a DIFFERENT class: infrastructure ACCESS
// material, the same category as add_service_ssh_key /
// create_cluster_kubeconfig, not identity. Spec CR-12 allows them behind an
// agent PAT, gated by `confirm: true`, with the minted secret shown exactly
// once. index.test.ts pins this.
//
// Safety kinds (the factory derives the confirm gate, the Safety sentence
// and destructiveHint from them):
//   - enable_registry, set_registry_tier: spends. Enabling starts the tier's
//     monthly price plus metered storage above quota; a tier change moves
//     the monthly price (an upgrade costs more).
//   - create_registry_credential, create_registry_kubernetes_manifest: sensitive +
//     returnsSecret. Each mints a live credential shown once.
//   - link_registry_cluster: sensitive. It installs a controller with
//     cluster-wide Secret/ServiceAccount write access; the full CR-7
//     disclosure is returned verbatim in `disclosure` and the description
//     tells the agent to relay it unedited.
//   - rotate_registry_cluster_link: disruptive (replaces a live credential; the
//     response never carries the new secret).
//   - close_registry, revoke_registry_credential, delete_registry_repository,
//     delete_registry_tag, delete_registry_manifest, unlink_registry_cluster:
//     destructive.
//
// Notes on inputs:
//   - close_registry: the API itself requires `?confirm=<handle>`, a second
//     confirmation layer on top of this tool's own `confirm: true` gate, so
//     `handle` is a real domain input. It goes into the query string through
//     URLSearchParams, so it can never alter the path.
//   - revoke_registry_credential: `id` mirrors the route's uuid rule, so a
//     ".." is rejected by zod before encodeSegment is reached.
//   - repo stays a loose `z.string().min(1)` (its real ceiling is shared
//     with the handle, see registry.ts), so a ".." reaches encodeSegment and
//     is rejected there. `tag` mirrors the route's TAG_RE, whose first
//     character class excludes '.', so a ".." tag is rejected by zod.
//   - create_registry_kubernetes_manifest: query parameters (scope/expiry/
//     namespace/secretName), not a body, mirroring the route. Sends
//     `Accept: application/json` (extraHeaders): the endpoint's default
//     answer is a raw `application/yaml` manifest; only that header gets
//     the structured `{credential,manifest,secret}` JSON.

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

// Every registry write answers this until the registry launches (the catalog
// flip), changing nothing. Said once per write description so an agent does not
// read a pre-launch 503 as an outage.
const NOT_LAUNCHED =
  'Until the registry launches the API answers 503 BACKEND_UNAVAILABLE ("The container registry is not ' +
  'available yet.") and changes nothing.';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function withSecretWarning(data: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: `${JSON.stringify(data, null, 2)}\n\n${SECRET_WARNING}` }] };
}

// --- enable_registry (POST /registry, spends) --------------------------------

export const enableRegistry: ToolDefinition = writeTool({
  name: 'enable_registry',
  description:
    'Enable the account\'s private container registry, or reopen/re-enable a previously closed one. ' +
    'Requires scope services:write. handle: 3-30 lowercase letters/digits, ' +
    'IMMUTABLE once set, becomes the image path prefix (`<hostname>/<handle>/<repo>`), EXCEPT when ' +
    're-enabling an account that was closed AND whose grace window has fully elapsed (storage already ' +
    'purged), where a different, currently-free handle may be supplied instead. tier: free, starter, ' +
    'premium, or enterprise; see list_registry_tiers to compare quotas/pricing first. If the account was ' +
    'closed via close_registry and is STILL inside its grace window, calling this again with the SAME ' +
    'handle REOPENS it (200, storage was never deleted). If the grace window elapsed, calling this ' +
    'RE-ENABLES it (200): the same handle is reclaimed, or a different free one may be used; the tier in ' +
    'this call applies fresh. A new registry answers 201. Errors: 400 for a malformed or reserved handle, ' +
    'or for an account not yet established enough to enable a billable resource (the same balance rule ' +
    'as ordering a cloud VM); 409 when the handle is taken (handle_taken), the registry is already ' +
    'enabled, the account is suspended, or it is closed and this request can neither reopen nor re-enable ' +
    'it; 429 RATE_LIMITED after 3 enable attempts per account (10 per network) in a day, counted only for ' +
    'well-formed attempts that reach the create/reopen step (a taken handle does not count). Check a ' +
    'handle with suggest_registry_handle first. ' + NOT_LAUNCHED,
  method: 'POST',
  idempotent: true,
  safety: {
    kind: 'spends',
    reason:
      'starts the registry\'s billing: the chosen tier\'s monthly price (free costs nothing) plus metered ' +
      'storage above the tier\'s quota',
  },
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
        description: 'Billing tier. See list_registry_tiers for quotas and pricing.',
      },
    },
    required: ['handle', 'tier'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/registry',
  buildBody: (a) => ({ handle: a.handle, tier: a.tier }),
});

// --- set_registry_tier (PATCH /registry, spends) ----------------------------

export const setRegistryTier: ToolDefinition = writeTool({
  name: 'set_registry_tier',
  description:
    'Change the billing tier of the account\'s container registry. Requires scope services:write. Same tier as today is a no-op (200, nothing changes). An UPGRADE (new tier\'s ' +
    'quota >= current) is always allowed and effective immediately. A DOWNGRADE is allowed only when the ' +
    'account has never been measured yet, or its latest usage sample is at or under the NEW tier\'s quota. ' +
    'Otherwise it is refused with 409 (tier_below_usage) so storage can never be downgraded out from under ' +
    'itself. Also 409 if the registry is closed (account_closed), 404 if it is not enabled. The response ' +
    'has no usage/quota/push; re-read get_registry. Use list_registry_tiers to compare quotas before choosing, ' +
    'and get_registry to check current usage. ' + NOT_LAUNCHED,
  method: 'PATCH',
  safety: {
    kind: 'spends',
    reason: 'changes the registry\'s monthly price; an upgrade to a larger tier costs more from now on',
  },
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

// --- close_registry (DELETE /registry?confirm=<handle>, confirm+destr) -----

export const closeRegistry: ToolDefinition = writeTool({
  name: 'close_registry',
  description:
    'Close the account\'s container registry. Requires scope services:write. DESTRUCTIVE: schedules the ' +
    'registry\'s storage for permanent deletion, but NOT immediately. The account stays reopenable with ' +
    'the SAME handle (enable_registry) until the returned deleteAfter time, after which an hourly job ' +
    'purges it for good. While closed, no other mutation is accepted except reopening. The API separately ' +
    'requires the account\'s OWN handle (from get_registry) as an explicit typed confirmation, passed here ' +
    'as `handle`. This is IN ADDITION to this tool\'s own confirm:true gate; both are required. Refused if ' +
    'already closed (409 account_closed) or suspended (409 account_suspended; contact support instead); ' +
    '400 if handle does not equal the registry\'s handle. Returns {status: "closed", deleteAfter}. ' +
    NOT_LAUNCHED,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason:
      'closes the registry; every image in it is deleted for good once deleteAfter passes unless the ' +
      'registry is reopened before then',
  },
  input: z.object({ handle: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        minLength: 1,
        description: 'The registry\'s own handle (from get_registry), typed to confirm. Must equal it exactly.',
      },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry?${new URLSearchParams({ confirm: String(a.handle) }).toString()}`,
});

// --- create_registry_credential (POST /registry/credentials, confirm) -----

export const createRegistryCredential: ToolDefinition = writeTool({
  name: 'create_registry_credential',
  description:
    'Create a robot credential for `docker login` / pull / push against the account\'s container registry. ' +
    'Requires scope services:write. name is your label for the credential and also half ' +
    'of the login username, `<handle>+<name>` (2-31 chars: lowercase letters/digits/hyphens, must start ' +
    'with a letter or digit). scope is pull (read-only) or push (read-write). expiresAt is an optional ISO ' +
    '8601 timestamp in the future; omit for a credential that never expires. Fails with credential_limit ' +
    'if the account already holds the maximum number of non-revoked credentials; revoke an unused one ' +
    'with revoke_registry_credential first (a revoked credential never counts). Also 409 when a ' +
    'credential with that name already exists, revoked ones included (names are never reused), or the ' +
    'registry is closed (account_closed). The secret is in this response only; it can never be retrieved ' +
    'again. ' + NOT_LAUNCHED,
  method: 'POST',
  idempotent: true,
  safety: {
    kind: 'sensitive',
    reason: 'creates a new credential that can pull (or pull and push) every repository in the registry until it is revoked or expires',
  },
  returnsSecret: 'the credential secret (the docker login password)',
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
  formatResult: withSecretWarning,
});

// --- revoke_registry_credential (DELETE /registry/credentials/{id}, confirm+destr) --

export const revokeRegistryCredential: ToolDefinition = writeTool({
  name: 'revoke_registry_credential',
  description:
    'Revoke a container registry robot credential immediately. Requires scope services:write. ' +
    'It stops authenticating right away. Mint a replacement with create_registry_credential if needed. ' +
    '404 if the credential is unknown, not yours, or already revoked; 409 if the registry is closed ' +
    '(account_closed). id (a uuid) comes from list_registry_credentials. ' + NOT_LAUNCHED,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: 'revokes the credential for good; every docker login, pull or push using it starts failing at once',
  },
  input: z.object({ id: z.string().uuid() }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Credential id (a uuid) from list_registry_credentials.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/credentials/${encodeSegment(a.id, 'id')}`,
});

// --- delete_registry_repository (DELETE /registry/repositories/{repo}, confirm+destr) --

export const deleteRegistryRepository: ToolDefinition = writeTool({
  name: 'delete_registry_repository',
  description:
    'Delete an entire repository from the account\'s container registry. Requires scope services:write. ' +
    'Deletes every distinct image (manifest digest) in the repository; ' +
    'every tag that pointed at any of them stops resolving. repo may itself contain `/` (e.g. `team/app`) ' +
    'and is always resolved under the account\'s own handle. Returns {deleted, pendingGc}: deleted is the ' +
    'number of distinct images removed. A repository the registry still holds but with no tags left (for ' +
    'example right after its last tag was deleted) answers deleted 0, not an error, and can be repeated. ' +
    'pendingGc is always true: untagged images the API cannot list (left by a tag delete or a re-push) stay ' +
    'pullable by digest until the registry removes them, about 8 days, and the repository keeps counting ' +
    'against the repository cap until then. 404 only when the registry no longer holds the repository at ' +
    'all (already deleted or never existed), or repo is malformed. repo comes from ' +
    'list_registry_repositories. ' + NOT_LAUNCHED,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: 'deletes every image in the repository for good; every tag in it stops resolving',
  },
  input: z.object({ repo: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        minLength: 1,
        description: 'Repository path relative to the account\'s handle (may contain /). From list_registry_repositories.',
      },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/repositories/${encodeSegment(a.repo, 'repo')}`,
});

// --- delete_registry_tag (DELETE /registry/repositories/{repo}/tags/{tag}, confirm+destr) --

export const deleteRegistryTag: ToolDefinition = writeTool({
  name: 'delete_registry_tag',
  description:
    'Delete one tag from a repository in the account\'s container registry. Requires scope ' +
    'services:write. Removes ONLY this tag reference. The image, any OTHER tag pointing at the same digest, ' +
    'and any multi-arch index listing it are untouched. If this was the image\'s last tag, the image stays ' +
    'pullable by digest until the registry removes untagged images, about 8 days; to remove it now use ' +
    'delete_registry_manifest with the tag\'s digest instead (delete_registry_repository removes ' +
    'everything in a repository). 404 if the tag does not exist (or the registry is not enabled, or repo is ' +
    'malformed). repo + tag come from get_registry_repository. ' + NOT_LAUNCHED,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: 'removes the tag; anything pulling by that tag stops resolving it',
  },
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
        description: 'The tag to delete, from get_registry_repository.',
      },
    },
    required: ['repo', 'tag'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/repositories/${encodeSegment(a.repo, 'repo')}/tags/${encodeSegment(a.tag, 'tag')}`,
});

// --- delete_registry_manifest (DELETE /registry/repositories/{repo}/manifests/{digest}, destructive) --

export const deleteRegistryManifest: ToolDefinition = writeTool({
  name: 'delete_registry_manifest',
  description:
    'Delete one image by its manifest digest from a repository in the account\'s container registry, ' +
    'removing the manifest and EVERY tag pointing at it, at once and for good. Requires scope ' +
    'services:write. Use it to free an image now instead of waiting for the registry to collect an ' +
    'untagged one (about 8 days after delete_registry_tag). digest is `sha256:` plus 64 lowercase hex ' +
    'characters, from the tag rows of get_registry_repository. When MORE than one tag points at the digest ' +
    'the API refuses with 409 CONFLICT ("Pass confirm=true to delete it anyway") unless ' +
    'confirm_multiple_tags is true (sent as the API\'s confirm=true); list which tags share the digest ' +
    'with get_registry_repository and show them to the user before setting it. A digest with zero or one ' +
    'tag needs no confirm_multiple_tags. A tag pushed to this digest while the request is in flight is ' +
    'removed too. Returns {deleted, tags}: tags are the tags seen pointing at it just before the delete, ' +
    'all now gone. 400 for a malformed digest; 404 when no manifest with this digest exists in the ' +
    'repository (or the registry is not enabled, or repo is malformed). ' + NOT_LAUNCHED,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: 'deletes the image and every tag pointing at it for good; anything pulling it by tag or digest fails',
  },
  input: z
    .object({
      repo: z.string().min(1),
      digest: z.string().regex(DIGEST_RE, 'digest must be sha256: followed by 64 lowercase hex characters.'),
      confirm_multiple_tags: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        minLength: 1,
        description: 'Repository path relative to the account\'s handle (may contain /). From list_registry_repositories.',
      },
      digest: {
        type: 'string',
        pattern: DIGEST_RE.source,
        description: 'Manifest digest (sha256:<64 hex>), from a tag row of get_registry_repository.',
      },
      confirm_multiple_tags: {
        type: 'boolean',
        description:
          'Set to true to delete a digest that more than one tag points at (the API\'s confirm=true). ' +
          'Without it such a delete is refused with 409 and nothing is removed. Only set it after the user ' +
          'saw which tags will go.',
      },
    },
    required: ['repo', 'digest'],
    additionalProperties: false,
  },
  buildPath: (a) => {
    const base =
      `/v1/registry/repositories/${encodeSegment(a.repo, 'repo')}` +
      `/manifests/${encodeSegment(a.digest, 'digest')}`;
    return a.confirm_multiple_tags === true ? `${base}?confirm=true` : base;
  },
});

// --- link_registry_cluster (POST /registry/clusters/{serviceId}, no gate) --

export const linkRegistryCluster: ToolDefinition = writeTool({
  name: 'link_registry_cluster',
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
    'reachable. 409 already_linked if this cluster is already linked; 404 if the registry is not enabled ' +
    'or the cluster is unknown or not yours. service_id comes from list_services (a cloud-k8s service); ' +
    'undo with unlink_registry_cluster. ' + NOT_LAUNCHED,
  method: 'POST',
  idempotent: true,
  safety: {
    kind: 'sensitive',
    reason:
      'installs a controller with cluster-wide Secret and ServiceAccount write access in the cluster and ' +
      'gives every namespace pull access to the registry',
  },
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

// --- unlink_registry_cluster (DELETE /registry/clusters/{serviceId}, confirm+destr) --

export const unlinkRegistryCluster: ToolDefinition = writeTool({
  name: 'unlink_registry_cluster',
  description:
    'Unlink a Kubernetes cluster from the account\'s container registry. Requires scope services:write. ' +
    'Removes everything link_registry_cluster installed (the secret-syncer, every ' +
    'namespace\'s copy of the pull secret, patched ServiceAccounts, the RBAC objects) and revokes the pull ' +
    'credential. Link again with link_registry_cluster if access is needed later. A cluster that is ' +
    'unreachable at call time stays "unlinking" and the hourly reconciler finishes the teardown; calling ' +
    'this again on a cluster already mid-unlink is a no-op, not an error. Returns {status: "unlinked" | ' +
    '"unlinking"}. 404 if this cluster is not linked. service_id comes from list_registry_clusters. ' +
    NOT_LAUNCHED,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason:
      'revokes the cluster\'s pull credential and removes the pull secret from every namespace; new image ' +
      'pulls from the registry in that cluster fail',
  },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Managed-Kubernetes service id from list_registry_clusters.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/clusters/${encodeSegment(a.service_id, 'service_id')}`,
});

// --- rotate_registry_cluster_link (POST /registry/clusters/{serviceId}/rotate, confirm) --

export const rotateRegistryClusterLink: ToolDefinition = writeTool({
  name: 'rotate_registry_cluster_link',
  description:
    'Rotate a linked cluster\'s registry pull credential. Requires scope services:write. Mints a fresh ' +
    'credential, pushes it into the cluster, and only revokes the OLD one once every namespace\'s copy has ' +
    'caught up, so the cluster never has a moment with no working credential. If propagation has not ' +
    'finished by the time this call returns, the response is status "rotating" and BOTH credentials stay ' +
    'live until the hourly reconciler confirms and finishes the swap. 409 rotation_in_progress if a ' +
    'rotation is already in flight for this cluster; 503 cluster_unreachable or kubeconfig_unavailable ' +
    'when the cluster cannot be reached, with the OLD credential untouched and still active (retry ' +
    'later). Does NOT return a secret: the new credential is installed directly into the cluster, never ' +
    'shown here. service_id comes from list_registry_clusters. ' + NOT_LAUNCHED,
  method: 'POST',
  safety: {
    kind: 'disruptive',
    reason: 'replaces the cluster\'s pull credential; the old one is revoked once every namespace has the new one',
  },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Managed-Kubernetes service id from list_registry_clusters.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/registry/clusters/${encodeSegment(a.service_id, 'service_id')}/rotate`,
});

// --- create_registry_kubernetes_manifest (POST /registry/docker-credentials/kubernetes, confirm) --

export const createRegistryKubernetesManifest: ToolDefinition = writeTool({
  name: 'create_registry_kubernetes_manifest',
  description:
    'Get a ready-to-apply pull-secret manifest for a Kubernetes cluster the account manages ITSELF (BYO: ' +
    'a kind/EKS/GKE/bare-metal cluster RareCloud does not run). The secret-syncer (link_registry_cluster) ' +
    'only installs where the api has direct cluster access, which a cluster RareCloud does not run never ' +
    'has. Requires scope services:write. Mints a NEW pull (or push) credential every call and returns it ' +
    'plus a Kubernetes Secret manifest (`type: kubernetes.io/dockerconfigjson`) ready for `kubectl apply ' +
    '-f`. scope (default pull), expiry (30d, 90d, 1y, or never; default 30d), namespace and ' +
    'secretName (DNS-1123 labels; default "default" / "rarecloud-registry") are all optional. Counts ' +
    'against the account\'s credential cap: 409 credential_limit once reached. Returns {credential, ' +
    'manifest, secret}. The secret is in this response only; it can never be retrieved again. ' +
    NOT_LAUNCHED,
  method: 'POST',
  safety: {
    kind: 'sensitive',
    reason: 'creates a new registry credential that can pull (or pull and push) every repository until it is revoked or expires',
  },
  returnsSecret: 'a new registry credential secret, also embedded in the Secret manifest',
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
  extraHeaders: { Accept: 'application/json' },
  formatResult: withSecretWarning,
});
