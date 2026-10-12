// Unit tests for the Container Registry WRITE tools (Plan 4 Task 5): enable/
// tier/close, robot-credential create/revoke, repository/tag delete, and
// cluster link/unlink/rotate + the BYO Kubernetes manifest. A fake client
// records method+path+body (no network); we assert closed schemas, the
// confirm/destructiveHint gates, path + segment encoding (incl. which layer,
// zod or encodeSegment, catches a ".." depending on each field's bounds),
// exact request bodies, the once-only secret-warning result shaping, and the
// uniform APIError -> errorResult mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enableRegistry,
  setRegistryTier,
  closeRegistry,
  createRegistryCredential,
  revokeRegistryCredential,
  deleteRegistryRepository,
  deleteRegistryTag,
  deleteRegistryManifest,
  linkRegistryCluster,
  unlinkRegistryCluster,
  rotateRegistryClusterLink,
  createRegistryKubernetesManifest,
} from './registry-write.js';
import { APIError, RareCloudClient } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

function fakeWriteClient(
  impl: (m: string, p: string, b?: unknown) => unknown = () => ({ ok: true }),
): { client: RareCloudClient; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const withBody = (method: string) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return impl(method, path, body);
  };
  const client = {
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    async delete(path: string) {
      calls.push({ method: 'DELETE', path });
      return impl('DELETE', path);
    },
  } as unknown as RareCloudClient;
  return { client, calls };
}

function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

// ---------------------------------------------------------------------------
// Shared table: every write tool with its gate flags and minimal valid
// DOMAIN args (excluding the factory-owned confirm). Drives the registry /
// gate / APIError assertions below, mirroring k8s-write.test.ts's pattern.
// ---------------------------------------------------------------------------

type Case = { tool: ToolDefinition; gated: boolean; destructive: boolean; args: Record<string, unknown> };

const TOOLS: Record<string, Case> = {
  enable_registry: { tool: enableRegistry, gated: true, destructive: false, args: { handle: 'acme', tier: 'free' } },
  set_registry_tier: { tool: setRegistryTier, gated: true, destructive: false, args: { tier: 'starter' } },
  close_registry: { tool: closeRegistry, gated: true, destructive: true, args: { handle: 'acme' } },
  create_registry_credential: { tool: createRegistryCredential, gated: true, destructive: false, args: { name: 'ci', scope: 'pull' } },
  revoke_registry_credential: { tool: revokeRegistryCredential, gated: true, destructive: true, args: { id: '11111111-1111-1111-1111-111111111111' } },
  delete_registry_repository: { tool: deleteRegistryRepository, gated: true, destructive: true, args: { repo: 'app' } },
  delete_registry_tag: { tool: deleteRegistryTag, gated: true, destructive: true, args: { repo: 'app', tag: '1.0' } },
  delete_registry_manifest: { tool: deleteRegistryManifest, gated: true, destructive: true, args: { repo: 'app', digest: `sha256:${'a'.repeat(64)}` } },
  link_registry_cluster: { tool: linkRegistryCluster, gated: true, destructive: false, args: { service_id: 'svc-1' } },
  unlink_registry_cluster: { tool: unlinkRegistryCluster, gated: true, destructive: true, args: { service_id: 'svc-1' } },
  rotate_registry_cluster_link: { tool: rotateRegistryClusterLink, gated: true, destructive: true, args: { service_id: 'svc-1' } },
  create_registry_kubernetes_manifest: { tool: createRegistryKubernetesManifest, gated: true, destructive: false, args: {} },
};

test('registry writes: each tool has its name, closed schema, services:write in description', () => {
  for (const [name, c] of Object.entries(TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.match(c.tool.description, /services:write/, `${name} description must name the scope`);
  }
});

test('registry writes: confirm advertised iff gated; destructiveHint iff destructive', () => {
  for (const [name, c] of Object.entries(TOOLS)) {
    const hasConfirm = 'confirm' in c.tool.inputSchema.properties;
    assert.equal(hasConfirm, c.gated, `${name}: confirm-in-schema must match gated=${c.gated}`);
    if (c.gated) {
      assert.ok((c.tool.inputSchema.required ?? []).includes('confirm'), `${name}: gated tool must require confirm`);
    } else {
      assert.ok(!('confirm' in c.tool.inputSchema.properties), `${name}: non-gated tool must not advertise confirm`);
    }
    assert.equal(
      c.tool.annotations?.destructiveHint ?? false,
      c.destructive,
      `${name}: destructiveHint must match destructive=${c.destructive}`,
    );
  }
});

test('registry writes: gated tools refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('registry writes: every tool issues exactly one request with confirm:true', async () => {
  for (const [name, c] of Object.entries(TOOLS)) {
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { ...c.args, confirm: true });
    assert.equal(result.isError, undefined, `${name} must succeed`);
    assert.equal(calls.length, 1, `${name} must issue exactly one request`);
  }
});

test('registry writes: APIError from the client maps to errorResult with [CODE] message', async () => {
  for (const [name, c] of Object.entries(TOOLS)) {
    const { client } = fakeWriteClient(() => {
      throw new APIError({ code: 'CONFLICT', message: 'conflict for ' + name });
    });
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must map APIError`);
    assert.equal(textOf(result), `Error: [CONFLICT] conflict for ${name}`, `${name} APIError message`);
  }
});

// --- enable_registry (POST /registry, spends) --------------------------------

test('enable_registry: POSTs {handle, tier} to /v1/registry', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await enableRegistry.handler(client, { handle: 'acme', tier: 'starter', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry', body: { handle: 'acme', tier: 'starter' } }]);
});

test('enable_registry: rejects a malformed handle before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const bad of ['AB', 'ab', 'has-hyphen', 'has_underscore', '']) {
    const result = await enableRegistry.handler(client, { handle: bad, tier: 'free', confirm: true });
    assert.equal(result.isError, true, `handle=${JSON.stringify(bad)} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for enable_registry:/);
  }
  assert.deepEqual(calls, []);
});

test('enable_registry: rejects an out-of-enum tier before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await enableRegistry.handler(client, { handle: 'acme', tier: 'gold', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for enable_registry:/);
  assert.deepEqual(calls, []);
});

test('enable_registry: JSON inputSchema mirrors the handle pattern', () => {
  const props = enableRegistry.inputSchema.properties as Record<string, { pattern?: string }>;
  assert.equal(props.handle.pattern, '^[a-z0-9]{3,30}$');
});

// --- set_registry_tier (PATCH /registry, spends) ----------------------------

test('set_registry_tier: PATCHes {tier} to /v1/registry', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setRegistryTier.handler(client, { tier: 'enterprise', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PATCH', path: '/v1/registry', body: { tier: 'enterprise' } }]);
});

test('set_registry_tier: rejects an out-of-enum tier before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setRegistryTier.handler(client, { tier: 'gold', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_registry_tier:/);
  assert.deepEqual(calls, []);
});

// --- close_registry (DELETE /registry?confirm=<handle>, confirm+destr) -----

test('close_registry: DELETEs /v1/registry?confirm=<handle> when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await closeRegistry.handler(client, { handle: 'acme', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry?confirm=acme' }]);
});

test('close_registry: percent-encodes special characters in handle within the query string', async () => {
  const { client, calls } = fakeWriteClient();
  await closeRegistry.handler(client, { handle: 'ac me', confirm: true });
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry?confirm=ac+me' }]);
});

test('close_registry: rejects an empty handle before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await closeRegistry.handler(client, { handle: '', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for close_registry:/);
  assert.deepEqual(calls, []);
});

// --- create_registry_credential (POST /registry/credentials, confirm) -----

const CREATED_CREDENTIAL = {
  id: 'cred-1',
  name: 'ci',
  scope: 'pull',
  username: 'acme+ci',
  expiresAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  secret: 'sekrit-value-shown-once-ABCDEF123456',
};

test('create_registry_credential: POSTs {name, scope} (expiresAt omitted) when confirmed', async () => {
  const { client, calls } = fakeWriteClient(() => CREATED_CREDENTIAL);
  const result = await createRegistryCredential.handler(client, { name: 'ci', scope: 'pull', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry/credentials', body: { name: 'ci', scope: 'pull' } }]);
});

test('create_registry_credential: forwards expiresAt when supplied', async () => {
  const { client, calls } = fakeWriteClient(() => CREATED_CREDENTIAL);
  await createRegistryCredential.handler(client, {
    name: 'ci',
    scope: 'push',
    expiresAt: '2030-01-01T00:00:00.000Z',
    confirm: true,
  });
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/registry/credentials', body: { name: 'ci', scope: 'push', expiresAt: '2030-01-01T00:00:00.000Z' } },
  ]);
});

test('create_registry_credential: rejects a malformed name before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const bad of ['-leading-hyphen', 'A', 'x', 'has spaces', 'UPPER']) {
    const result = await createRegistryCredential.handler(client, { name: bad, scope: 'pull', confirm: true });
    assert.equal(result.isError, true, `name=${JSON.stringify(bad)} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for create_registry_credential:/);
  }
  assert.deepEqual(calls, []);
});

test('create_registry_credential: rejects an out-of-enum scope before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createRegistryCredential.handler(client, { name: 'ci', scope: 'admin', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_registry_credential:/);
  assert.deepEqual(calls, []);
});

test('create_registry_credential: rejects a malformed expiresAt before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createRegistryCredential.handler(client, { name: 'ci', scope: 'pull', expiresAt: 'not-a-date', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_registry_credential:/);
  assert.deepEqual(calls, []);
});

test('create_registry_credential: the secret appears exactly once in the result, plus a once-only warning', async () => {
  const { client } = fakeWriteClient(() => CREATED_CREDENTIAL);
  const result = await createRegistryCredential.handler(client, { name: 'ci', scope: 'pull', confirm: true });
  const text = textOf(result);
  const secret = CREATED_CREDENTIAL.secret;
  const occurrences = text.split(secret).length - 1;
  assert.equal(occurrences, 1, 'the secret must appear exactly once in the result text');
  assert.match(text, /shown ONLY in this response and can never be retrieved again/i);
  assert.match(text, /"secret": "sekrit-value-shown-once-ABCDEF123456"/);
});

test('create_registry_credential: the secret is never passed to console.log/warn/error', async () => {
  const { client } = fakeWriteClient(() => CREATED_CREDENTIAL);
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const seen: string[] = [];
  const capture = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await createRegistryCredential.handler(client, { name: 'ci', scope: 'pull', confirm: true });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.ok(!seen.some((s) => s.includes(CREATED_CREDENTIAL.secret)), 'the secret must never reach console.*');
});

// --- revoke_registry_credential (DELETE /registry/credentials/{id}, confirm+destr) --

test('revoke_registry_credential: DELETEs /v1/registry/credentials/{id} when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const id = '11111111-1111-1111-1111-111111111111';
  const result = await revokeRegistryCredential.handler(client, { id, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: `/v1/registry/credentials/${id}` }]);
});

// DEVIATION-AWARE: `id` mirrors z.string().uuid() (openapi format:uuid), a
// TIGHTER bound than the loose .min(1) k8s-write.ts uses for credential_id,
// so a ".." value is rejected by ZOD ("Invalid uuid"), never reaching
// encodeSegment's own traversal check. See the file header for the ruling.
test('revoke_registry_credential: a non-uuid id (including "..") is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const bad of ['..', 'not-a-uuid', '']) {
    const result = await revokeRegistryCredential.handler(client, { id: bad, confirm: true });
    assert.equal(result.isError, true, `id=${JSON.stringify(bad)} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for revoke_registry_credential:/);
    assert.match(textOf(result), /uuid/i);
  }
  assert.deepEqual(calls, []);
});

// --- delete_registry_repository (DELETE /registry/repositories/{repo}, confirm+destr) --

test('delete_registry_repository: DELETEs /v1/registry/repositories/{repo} when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteRegistryRepository.handler(client, { repo: 'app', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/repositories/app' }]);
});

test('delete_registry_repository: a repo containing "/" is encoded as one opaque segment', async () => {
  const { client, calls } = fakeWriteClient();
  await deleteRegistryRepository.handler(client, { repo: 'team/app', confirm: true });
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/repositories/team%2Fapp' }]);
});

// repo is a loose z.string().min(1): ".." passes zod and is caught by
// encodeSegment instead (unlike credentials_revoke's id above).
test('delete_registry_repository: a ".." repo is rejected by encodeSegment before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteRegistryRepository.handler(client, { repo: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid repo value');
  assert.deepEqual(calls, []);
});

// --- delete_registry_tag (DELETE /registry/repositories/{repo}/tags/{tag}, confirm+destr) --

test('delete_registry_tag: DELETEs /v1/registry/repositories/{repo}/tags/{tag} when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteRegistryTag.handler(client, { repo: 'app', tag: 'v1.2.3-rc1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/repositories/app/tags/v1.2.3-rc1' }]);
});

test('delete_registry_tag: a ".." repo is rejected by encodeSegment before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteRegistryTag.handler(client, { repo: '..', tag: '1.0', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid repo value');
  assert.deepEqual(calls, []);
});

// tag mirrors TAG_RE, whose first-character class excludes '.', so ".." is
// caught by ZOD, never reaching encodeSegment for this field.
test('delete_registry_tag: a ".." tag is rejected by zod (TAG_RE) before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteRegistryTag.handler(client, { repo: 'app', tag: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for delete_registry_tag:/);
  assert.match(textOf(result), /valid OCI tag/);
  assert.deepEqual(calls, []);
});

test('delete_registry_tag: description says a missing tag is a 404 and points at the digest delete', () => {
  assert.match(deleteRegistryTag.description, /404 if the tag does not exist/);
  assert.match(deleteRegistryTag.description, /about 8 days/);
  assert.match(deleteRegistryTag.description, /delete_registry_manifest/);
});

// --- delete_registry_repository contract notes ------------------------------

test('delete_registry_repository: description says an empty repository answers deleted 0, not 404', () => {
  assert.match(deleteRegistryRepository.description, /answers deleted 0, not an error/);
  assert.match(deleteRegistryRepository.description, /pendingGc is always true/);
  assert.match(deleteRegistryRepository.description, /404 only when the registry no longer holds the repository/);
  assert.doesNotMatch(deleteRegistryRepository.description, /Fails with a not-found if the repository has no tags/);
});

// --- delete_registry_manifest (DELETE /registry/repositories/{repo}/manifests/{digest}) --

const DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;

test('delete_registry_manifest: DELETEs .../manifests/{digest} with no confirm query by default', async () => {
  const { client, calls } = fakeWriteClient(() => ({ deleted: 1, tags: ['1.0'] }));
  const result = await deleteRegistryManifest.handler(client, { repo: 'app', digest: DIGEST, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: `/v1/registry/repositories/app/manifests/sha256%3A${DIGEST.slice(7)}` }]);
});

test('delete_registry_manifest: confirm_multiple_tags:true adds the API\'s ?confirm=true', async () => {
  const { client, calls } = fakeWriteClient(() => ({ deleted: 1, tags: ['1.0', 'latest'] }));
  await deleteRegistryManifest.handler(client, { repo: 'team/app', digest: DIGEST, confirm_multiple_tags: true, confirm: true });
  assert.deepEqual(calls, [
    { method: 'DELETE', path: `/v1/registry/repositories/team%2Fapp/manifests/sha256%3A${DIGEST.slice(7)}?confirm=true` },
  ]);
});

test('delete_registry_manifest: confirm_multiple_tags:false sends no confirm query', async () => {
  const { client, calls } = fakeWriteClient();
  await deleteRegistryManifest.handler(client, { repo: 'app', digest: DIGEST, confirm_multiple_tags: false, confirm: true });
  assert.ok(!calls[0].path.includes('?'), calls[0].path);
});

test('delete_registry_manifest: the tool gate (confirm) does not by itself send the API confirm', async () => {
  // confirm:true approves the delete; only confirm_multiple_tags opts into the
  // API's multi-tag confirmation, so the 409 still protects tags the user never saw.
  const { client, calls } = fakeWriteClient();
  await deleteRegistryManifest.handler(client, { repo: 'app', digest: DIGEST, confirm: true });
  assert.ok(!calls[0].path.includes('confirm'), calls[0].path);
});

test('delete_registry_manifest: rejects a malformed digest before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const bad of ['sha256:abc', `sha512:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`, '..', '']) {
    const result = await deleteRegistryManifest.handler(client, { repo: 'app', digest: bad, confirm: true });
    assert.equal(result.isError, true, `digest=${JSON.stringify(bad)} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for delete_registry_manifest:/);
  }
  assert.deepEqual(calls, []);
});

test('delete_registry_manifest: a ".." repo is rejected by encodeSegment before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteRegistryManifest.handler(client, { repo: '..', digest: DIGEST, confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid repo value');
  assert.deepEqual(calls, []);
});

test('delete_registry_manifest: JSON inputSchema mirrors the digest pattern and keeps confirm_multiple_tags optional', () => {
  const props = deleteRegistryManifest.inputSchema.properties as Record<string, { pattern?: string; type?: string }>;
  assert.equal(props.digest.pattern, '^sha256:[a-f0-9]{64}$');
  assert.equal(props.confirm_multiple_tags.type, 'boolean');
  assert.deepEqual([...(deleteRegistryManifest.inputSchema.required ?? [])].sort(), ['confirm', 'digest', 'repo']);
});

test('delete_registry_manifest: description covers the 409 without confirm and the 404 for a missing digest', () => {
  assert.match(deleteRegistryManifest.description, /MORE than one tag points at the digest/);
  assert.match(deleteRegistryManifest.description, /409 CONFLICT/);
  assert.match(deleteRegistryManifest.description, /confirm_multiple_tags is true \(sent as the API's confirm=true\)/);
  assert.match(deleteRegistryManifest.description, /404 when no manifest with this digest exists/);
});

test('delete_registry_manifest: a real 409 from the API surfaces as an error result', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'CONFLICT', message: 'This digest is referenced by 2 tags. Pass confirm=true to delete it anyway.' });
  });
  const result = await deleteRegistryManifest.handler(client, { repo: 'app', digest: DIGEST, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: \[CONFLICT\] This digest is referenced by 2 tags/);
});

// --- error-contract notes on the other writes --------------------------------

test('enable_registry: description covers the velocity limit, the established-account 400 and the 201/200 split', () => {
  assert.match(enableRegistry.description, /429 RATE_LIMITED after 3 enable attempts per account \(10 per network\)/);
  assert.match(enableRegistry.description, /not yet established/);
  assert.match(enableRegistry.description, /answers 201/);
});

test('registry writes: every write says a pre-launch 503 changes nothing', () => {
  for (const [name, c] of Object.entries(TOOLS)) {
    assert.match(c.tool.description, /503 BACKEND_UNAVAILABLE/, `${name} must mention the pre-launch 503`);
  }
});

test('create_registry_credential: description says revoked names are never reused', () => {
  assert.match(createRegistryCredential.description, /revoked ones included \(names are never reused\)/);
});

test('rotate_registry_cluster_link: description says a 503 leaves the old credential active', () => {
  assert.match(rotateRegistryClusterLink.description, /503 cluster_unreachable or kubeconfig_unavailable/);
  assert.match(rotateRegistryClusterLink.description, /OLD credential untouched and still active/);
});

// --- link_registry_cluster (POST /registry/clusters/{serviceId}, sensitive) --

const LINK_RESPONSE = {
  link: {
    serviceId: 'svc-1',
    status: 'active',
    credentialName: 'k8s-svc-1',
    secretName: 'rarecloud-registry-credentials',
    installs: ['Secret/rarecloud-registry-credentials', 'ServiceAccount/rarecloud-registry-syncer'],
  },
  disclosure: 'Linking installs a small controller... TEST DISCLOSURE TEXT ...Unlinking removes everything it installed.',
};

test('link_registry_cluster: POSTs to /v1/registry/clusters/{service_id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient(() => LINK_RESPONSE);
  const result = await linkRegistryCluster.handler(client, { service_id: 'svc-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry/clusters/svc-1', body: undefined }]);
});

test('link_registry_cluster: the disclosure text is returned verbatim in the result', async () => {
  const { client } = fakeWriteClient(() => LINK_RESPONSE);
  const result = await linkRegistryCluster.handler(client, { service_id: 'svc-1', confirm: true });
  const parsed = JSON.parse(textOf(result));
  assert.equal(parsed.disclosure, LINK_RESPONSE.disclosure);
  assert.equal(parsed.link.credentialName, 'k8s-svc-1');
});

test('link_registry_cluster: description instructs relaying the disclosure verbatim', () => {
  assert.match(linkRegistryCluster.description, /disclosure/);
  assert.match(linkRegistryCluster.description, /verbatim/i);
});

test('link_registry_cluster: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await linkRegistryCluster.handler(client, { service_id: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, []);
});

// --- unlink_registry_cluster (DELETE /registry/clusters/{serviceId}, confirm+destr) --

test('unlink_registry_cluster: DELETEs /v1/registry/clusters/{service_id} when confirmed', async () => {
  const { client, calls } = fakeWriteClient(() => ({ status: 'unlinked' }));
  const result = await unlinkRegistryCluster.handler(client, { service_id: 'svc-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/clusters/svc-1' }]);
});

test('unlink_registry_cluster: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await unlinkRegistryCluster.handler(client, { service_id: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, []);
});

// --- rotate_registry_cluster_link (POST /registry/clusters/{serviceId}/rotate, confirm) --

test('rotate_registry_cluster_link: POSTs to /v1/registry/clusters/{service_id}/rotate when confirmed', async () => {
  const { client, calls } = fakeWriteClient(() => ({ status: 'active', credentialName: 'k8s-svc-1-202601010000' }));
  const result = await rotateRegistryClusterLink.handler(client, { service_id: 'svc-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry/clusters/svc-1/rotate', body: undefined }]);
});

test('rotate_registry_cluster_link: description states no secret is returned', () => {
  assert.match(rotateRegistryClusterLink.description, /does not return a secret|never shown here/i);
});

test('rotate_registry_cluster_link: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await rotateRegistryClusterLink.handler(client, { service_id: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, []);
});

// --- create_registry_kubernetes_manifest (POST /registry/docker-credentials/kubernetes, confirm) --

const MANIFEST_RESPONSE = {
  credential: {
    id: 'cred-byo-1',
    name: 'byo-a1b2c3d4',
    scope: 'pull',
    username: 'acme+byo-a1b2c3d4',
    expiresAt: '2026-02-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  manifest: '# RareCloud registry pull secret\napiVersion: v1\nkind: Secret\n...',
  secret: 'byo-secret-shown-once-XYZ987',
};

test('create_registry_kubernetes_manifest: POSTs with no query string when every field is omitted', async () => {
  const { client, calls } = fakeWriteClient(() => MANIFEST_RESPONSE);
  const result = await createRegistryKubernetesManifest.handler(client, { confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/registry/docker-credentials/kubernetes', body: undefined },
  ]);
});

test('create_registry_kubernetes_manifest: forwards scope/expiry/namespace/secretName as query params', async () => {
  const { client, calls } = fakeWriteClient(() => MANIFEST_RESPONSE);
  await createRegistryKubernetesManifest.handler(client, {
    scope: 'push',
    expiry: '1y',
    namespace: 'prod',
    secretName: 'my-pull-secret',
    confirm: true,
  });
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/registry/docker-credentials/kubernetes?scope=push&expiry=1y&namespace=prod&secretName=my-pull-secret',
      body: undefined,
    },
  ]);
});

test('create_registry_kubernetes_manifest: rejects an invalid namespace/secretName before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const badNs = await createRegistryKubernetesManifest.handler(client, { namespace: 'Bad_NS', confirm: true });
  assert.equal(badNs.isError, true);
  assert.match(textOf(badNs), /^Error: Invalid input for create_registry_kubernetes_manifest:/);
  const badSecretName = await createRegistryKubernetesManifest.handler(client, { secretName: 'UPPER', confirm: true });
  assert.equal(badSecretName.isError, true);
  assert.deepEqual(calls, []);
});

test('create_registry_kubernetes_manifest: rejects an out-of-enum scope/expiry before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const badScope = await createRegistryKubernetesManifest.handler(client, { scope: 'admin', confirm: true });
  assert.equal(badScope.isError, true);
  const badExpiry = await createRegistryKubernetesManifest.handler(client, { expiry: '5y', confirm: true });
  assert.equal(badExpiry.isError, true);
  assert.deepEqual(calls, []);
});

test('create_registry_kubernetes_manifest: sends Accept: application/json as an extra header', async () => {
  const calls: Array<{ path: string; headers?: Record<string, string> }> = [];
  const client = {
    post: async (path: string, _body?: unknown, opts?: { headers?: Record<string, string> }) => {
      calls.push({ path, headers: opts?.headers });
      return MANIFEST_RESPONSE;
    },
  } as unknown as RareCloudClient;
  await createRegistryKubernetesManifest.handler(client, { confirm: true });
  assert.deepEqual(calls, [
    { path: '/v1/registry/docker-credentials/kubernetes', headers: { Accept: 'application/json' } },
  ]);
});

test('create_registry_kubernetes_manifest: the secret appears exactly once in the result, plus a once-only warning', async () => {
  const { client } = fakeWriteClient(() => MANIFEST_RESPONSE);
  const result = await createRegistryKubernetesManifest.handler(client, { confirm: true });
  const text = textOf(result);
  const occurrences = text.split(MANIFEST_RESPONSE.secret).length - 1;
  assert.equal(occurrences, 1, 'the secret must appear exactly once in the result text');
  assert.match(text, /shown ONLY in this response and can never be retrieved again/i);
  // The manifest text itself is also carried through, once.
  assert.match(text, /kind: Secret/);
});

test('create_registry_kubernetes_manifest: the secret is never passed to console.log/warn/error', async () => {
  const { client } = fakeWriteClient(() => MANIFEST_RESPONSE);
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const seen: string[] = [];
  const capture = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    await createRegistryKubernetesManifest.handler(client, { confirm: true });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.ok(!seen.some((s) => s.includes(MANIFEST_RESPONSE.secret)), 'the secret must never reach console.*');
});

// ---------------------------------------------------------------------------
// Fix round 1: revoke_registry_credential and delete_registry_tag both hit
// a REAL 204 No Content route (v1-registry.ts's credentialDELETE and
// v1-registry-repos.ts's tag-delete branch, both `new Response(null,
// {status: 204})`). The fakeWriteClient used everywhere above never touches
// the real client.ts fetch/JSON.parse path, so it could not have caught the
// bug where an empty body threw a false INVALID_RESPONSE on every success.
// These two tests go through a REAL RareCloudClient with global fetch
// stubbed to a genuine empty-body 204 Response, exercising the actual
// client.ts code the fake normally bypasses.
// ---------------------------------------------------------------------------

function stubRealFetch(response: Response): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

test('revoke_registry_credential: a real 204 No Content response is a success, not INVALID_RESPONSE', async () => {
  const stub = stubRealFetch(new Response(null, { status: 204 }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const result = await revokeRegistryCredential.handler(client, {
      id: '11111111-1111-1111-1111-111111111111',
      confirm: true,
    });
    assert.equal(result.isError, undefined, textOf(result));
  } finally {
    stub.restore();
  }
});

test('delete_registry_manifest: a real 202 JSON response comes back as the parsed result', async () => {
  const stub = stubRealFetch(
    new Response(JSON.stringify({ ok: true, data: { deleted: 1, tags: ['1.0'] } }), { status: 202 }),
  );
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const result = await deleteRegistryManifest.handler(client, { repo: 'app', digest: DIGEST, confirm: true });
    assert.equal(result.isError, undefined, textOf(result));
    assert.deepEqual(JSON.parse(textOf(result)), { deleted: 1, tags: ['1.0'] });
  } finally {
    stub.restore();
  }
});

test('delete_registry_tag: a real 204 No Content response is a success, not INVALID_RESPONSE', async () => {
  const stub = stubRealFetch(new Response(null, { status: 204 }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const result = await deleteRegistryTag.handler(client, { repo: 'app', tag: '1.0', confirm: true });
    assert.equal(result.isError, undefined, textOf(result));
  } finally {
    stub.restore();
  }
});
