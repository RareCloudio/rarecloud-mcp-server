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
  registryEnable,
  registrySetTier,
  registryClose,
  registryCredentialsCreate,
  registryCredentialsRevoke,
  registryRepositoryDelete,
  registryTagDelete,
  registryClusterLink,
  registryClusterUnlink,
  registryClusterRotate,
  registryKubernetesManifest,
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
  registry_enable: { tool: registryEnable, gated: false, destructive: false, args: { handle: 'acme', tier: 'free' } },
  registry_set_tier: { tool: registrySetTier, gated: false, destructive: false, args: { tier: 'starter' } },
  registry_close: { tool: registryClose, gated: true, destructive: true, args: { handle: 'acme' } },
  registry_credentials_create: { tool: registryCredentialsCreate, gated: true, destructive: false, args: { name: 'ci', scope: 'pull' } },
  registry_credentials_revoke: { tool: registryCredentialsRevoke, gated: true, destructive: true, args: { id: '11111111-1111-1111-1111-111111111111' } },
  registry_repository_delete: { tool: registryRepositoryDelete, gated: true, destructive: true, args: { repo: 'app' } },
  registry_tag_delete: { tool: registryTagDelete, gated: true, destructive: true, args: { repo: 'app', tag: '1.0' } },
  registry_cluster_link: { tool: registryClusterLink, gated: false, destructive: false, args: { service_id: 'svc-1' } },
  registry_cluster_unlink: { tool: registryClusterUnlink, gated: true, destructive: true, args: { service_id: 'svc-1' } },
  registry_cluster_rotate: { tool: registryClusterRotate, gated: true, destructive: false, args: { service_id: 'svc-1' } },
  registry_kubernetes_manifest: { tool: registryKubernetesManifest, gated: true, destructive: false, args: {} },
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

test('registry writes: non-gated tools issue exactly one request with confirm absent', async () => {
  for (const [name, c] of Object.entries(TOOLS)) {
    if (c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { ...c.args });
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

// --- registry_enable (POST /registry, no gate) ------------------------------

test('registry_enable: POSTs {handle, tier} to /v1/registry', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryEnable.handler(client, { handle: 'acme', tier: 'starter' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry', body: { handle: 'acme', tier: 'starter' } }]);
});

test('registry_enable: rejects a malformed handle before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const bad of ['AB', 'ab', 'has-hyphen', 'has_underscore', '']) {
    const result = await registryEnable.handler(client, { handle: bad, tier: 'free' });
    assert.equal(result.isError, true, `handle=${JSON.stringify(bad)} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for registry_enable:/);
  }
  assert.deepEqual(calls, []);
});

test('registry_enable: rejects an out-of-enum tier before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryEnable.handler(client, { handle: 'acme', tier: 'gold' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for registry_enable:/);
  assert.deepEqual(calls, []);
});

test('registry_enable: JSON inputSchema mirrors the handle pattern', () => {
  const props = registryEnable.inputSchema.properties as Record<string, { pattern?: string }>;
  assert.equal(props.handle.pattern, '^[a-z0-9]{3,30}$');
});

// --- registry_set_tier (PATCH /registry, no gate) ---------------------------

test('registry_set_tier: PATCHes {tier} to /v1/registry', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registrySetTier.handler(client, { tier: 'enterprise' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PATCH', path: '/v1/registry', body: { tier: 'enterprise' } }]);
});

test('registry_set_tier: rejects an out-of-enum tier before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registrySetTier.handler(client, { tier: 'gold' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for registry_set_tier:/);
  assert.deepEqual(calls, []);
});

// --- registry_close (DELETE /registry?confirm=<handle>, confirm+destr) -----

test('registry_close: DELETEs /v1/registry?confirm=<handle> when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryClose.handler(client, { handle: 'acme', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry?confirm=acme' }]);
});

test('registry_close: percent-encodes special characters in handle within the query string', async () => {
  const { client, calls } = fakeWriteClient();
  await registryClose.handler(client, { handle: 'ac me', confirm: true });
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry?confirm=ac+me' }]);
});

test('registry_close: rejects an empty handle before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryClose.handler(client, { handle: '', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for registry_close:/);
  assert.deepEqual(calls, []);
});

// --- registry_credentials_create (POST /registry/credentials, confirm) -----

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

test('registry_credentials_create: POSTs {name, scope} (expiresAt omitted) when confirmed', async () => {
  const { client, calls } = fakeWriteClient(() => CREATED_CREDENTIAL);
  const result = await registryCredentialsCreate.handler(client, { name: 'ci', scope: 'pull', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry/credentials', body: { name: 'ci', scope: 'pull' } }]);
});

test('registry_credentials_create: forwards expiresAt when supplied', async () => {
  const { client, calls } = fakeWriteClient(() => CREATED_CREDENTIAL);
  await registryCredentialsCreate.handler(client, {
    name: 'ci',
    scope: 'push',
    expiresAt: '2030-01-01T00:00:00.000Z',
    confirm: true,
  });
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/registry/credentials', body: { name: 'ci', scope: 'push', expiresAt: '2030-01-01T00:00:00.000Z' } },
  ]);
});

test('registry_credentials_create: rejects a malformed name before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const bad of ['-leading-hyphen', 'A', 'x', 'has spaces', 'UPPER']) {
    const result = await registryCredentialsCreate.handler(client, { name: bad, scope: 'pull', confirm: true });
    assert.equal(result.isError, true, `name=${JSON.stringify(bad)} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for registry_credentials_create:/);
  }
  assert.deepEqual(calls, []);
});

test('registry_credentials_create: rejects an out-of-enum scope before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryCredentialsCreate.handler(client, { name: 'ci', scope: 'admin', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for registry_credentials_create:/);
  assert.deepEqual(calls, []);
});

test('registry_credentials_create: rejects a malformed expiresAt before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryCredentialsCreate.handler(client, { name: 'ci', scope: 'pull', expiresAt: 'not-a-date', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for registry_credentials_create:/);
  assert.deepEqual(calls, []);
});

test('registry_credentials_create: the secret appears exactly once in the result, plus a once-only warning', async () => {
  const { client } = fakeWriteClient(() => CREATED_CREDENTIAL);
  const result = await registryCredentialsCreate.handler(client, { name: 'ci', scope: 'pull', confirm: true });
  const text = textOf(result);
  const secret = CREATED_CREDENTIAL.secret;
  const occurrences = text.split(secret).length - 1;
  assert.equal(occurrences, 1, 'the secret must appear exactly once in the result text');
  assert.match(text, /shown ONLY in this response and can never be retrieved again/i);
  assert.match(text, /"secret": "sekrit-value-shown-once-ABCDEF123456"/);
});

test('registry_credentials_create: the secret is never passed to console.log/warn/error', async () => {
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
    await registryCredentialsCreate.handler(client, { name: 'ci', scope: 'pull', confirm: true });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.ok(!seen.some((s) => s.includes(CREATED_CREDENTIAL.secret)), 'the secret must never reach console.*');
});

// --- registry_credentials_revoke (DELETE /registry/credentials/{id}, confirm+destr) --

test('registry_credentials_revoke: DELETEs /v1/registry/credentials/{id} when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const id = '11111111-1111-1111-1111-111111111111';
  const result = await registryCredentialsRevoke.handler(client, { id, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: `/v1/registry/credentials/${id}` }]);
});

// DEVIATION-AWARE: `id` mirrors z.string().uuid() (openapi format:uuid), a
// TIGHTER bound than the loose .min(1) k8s-write.ts uses for credential_id,
// so a ".." value is rejected by ZOD ("Invalid uuid"), never reaching
// encodeSegment's own traversal check. See the file header for the ruling.
test('registry_credentials_revoke: a non-uuid id (including "..") is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const bad of ['..', 'not-a-uuid', '']) {
    const result = await registryCredentialsRevoke.handler(client, { id: bad, confirm: true });
    assert.equal(result.isError, true, `id=${JSON.stringify(bad)} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for registry_credentials_revoke:/);
    assert.match(textOf(result), /uuid/i);
  }
  assert.deepEqual(calls, []);
});

// --- registry_repository_delete (DELETE /registry/repositories/{repo}, confirm+destr) --

test('registry_repository_delete: DELETEs /v1/registry/repositories/{repo} when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryRepositoryDelete.handler(client, { repo: 'app', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/repositories/app' }]);
});

test('registry_repository_delete: a repo containing "/" is encoded as one opaque segment', async () => {
  const { client, calls } = fakeWriteClient();
  await registryRepositoryDelete.handler(client, { repo: 'team/app', confirm: true });
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/repositories/team%2Fapp' }]);
});

// repo is a loose z.string().min(1): ".." passes zod and is caught by
// encodeSegment instead (unlike credentials_revoke's id above).
test('registry_repository_delete: a ".." repo is rejected by encodeSegment before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryRepositoryDelete.handler(client, { repo: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid repo value');
  assert.deepEqual(calls, []);
});

// --- registry_tag_delete (DELETE /registry/repositories/{repo}/tags/{tag}, confirm+destr) --

test('registry_tag_delete: DELETEs /v1/registry/repositories/{repo}/tags/{tag} when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryTagDelete.handler(client, { repo: 'app', tag: 'v1.2.3-rc1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/repositories/app/tags/v1.2.3-rc1' }]);
});

test('registry_tag_delete: a ".." repo is rejected by encodeSegment before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryTagDelete.handler(client, { repo: '..', tag: '1.0', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid repo value');
  assert.deepEqual(calls, []);
});

// tag mirrors TAG_RE, whose first-character class excludes '.', so ".." is
// caught by ZOD, never reaching encodeSegment for this field.
test('registry_tag_delete: a ".." tag is rejected by zod (TAG_RE) before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryTagDelete.handler(client, { repo: 'app', tag: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for registry_tag_delete:/);
  assert.match(textOf(result), /valid OCI tag/);
  assert.deepEqual(calls, []);
});

// --- registry_cluster_link (POST /registry/clusters/{serviceId}, no gate) --

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

test('registry_cluster_link: POSTs to /v1/registry/clusters/{service_id} with no body, no confirm required', async () => {
  const { client, calls } = fakeWriteClient(() => LINK_RESPONSE);
  const result = await registryClusterLink.handler(client, { service_id: 'svc-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry/clusters/svc-1', body: undefined }]);
});

test('registry_cluster_link: the disclosure text is returned verbatim in the result', async () => {
  const { client } = fakeWriteClient(() => LINK_RESPONSE);
  const result = await registryClusterLink.handler(client, { service_id: 'svc-1' });
  const parsed = JSON.parse(textOf(result));
  assert.equal(parsed.disclosure, LINK_RESPONSE.disclosure);
  assert.equal(parsed.link.credentialName, 'k8s-svc-1');
});

test('registry_cluster_link: description instructs relaying the disclosure verbatim', () => {
  assert.match(registryClusterLink.description, /disclosure/);
  assert.match(registryClusterLink.description, /verbatim/i);
});

test('registry_cluster_link: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryClusterLink.handler(client, { service_id: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, []);
});

// --- registry_cluster_unlink (DELETE /registry/clusters/{serviceId}, confirm+destr) --

test('registry_cluster_unlink: DELETEs /v1/registry/clusters/{service_id} when confirmed', async () => {
  const { client, calls } = fakeWriteClient(() => ({ status: 'unlinked' }));
  const result = await registryClusterUnlink.handler(client, { service_id: 'svc-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/registry/clusters/svc-1' }]);
});

test('registry_cluster_unlink: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryClusterUnlink.handler(client, { service_id: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, []);
});

// --- registry_cluster_rotate (POST /registry/clusters/{serviceId}/rotate, confirm) --

test('registry_cluster_rotate: POSTs to /v1/registry/clusters/{service_id}/rotate when confirmed', async () => {
  const { client, calls } = fakeWriteClient(() => ({ status: 'active', credentialName: 'k8s-svc-1-202601010000' }));
  const result = await registryClusterRotate.handler(client, { service_id: 'svc-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/registry/clusters/svc-1/rotate', body: undefined }]);
});

test('registry_cluster_rotate: description states no secret is returned', () => {
  assert.match(registryClusterRotate.description, /does not return a secret|never shown here/i);
});

test('registry_cluster_rotate: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registryClusterRotate.handler(client, { service_id: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, []);
});

// --- registry_kubernetes_manifest (POST /registry/docker-credentials/kubernetes, confirm) --

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

test('registry_kubernetes_manifest: POSTs with no query string when every field is omitted', async () => {
  const { client, calls } = fakeWriteClient(() => MANIFEST_RESPONSE);
  const result = await registryKubernetesManifest.handler(client, { confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/registry/docker-credentials/kubernetes', body: undefined },
  ]);
});

test('registry_kubernetes_manifest: forwards scope/expiry/namespace/secretName as query params', async () => {
  const { client, calls } = fakeWriteClient(() => MANIFEST_RESPONSE);
  await registryKubernetesManifest.handler(client, {
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

test('registry_kubernetes_manifest: rejects an invalid namespace/secretName before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const badNs = await registryKubernetesManifest.handler(client, { namespace: 'Bad_NS', confirm: true });
  assert.equal(badNs.isError, true);
  assert.match(textOf(badNs), /^Error: Invalid input for registry_kubernetes_manifest:/);
  const badSecretName = await registryKubernetesManifest.handler(client, { secretName: 'UPPER', confirm: true });
  assert.equal(badSecretName.isError, true);
  assert.deepEqual(calls, []);
});

test('registry_kubernetes_manifest: rejects an out-of-enum scope/expiry before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const badScope = await registryKubernetesManifest.handler(client, { scope: 'admin', confirm: true });
  assert.equal(badScope.isError, true);
  const badExpiry = await registryKubernetesManifest.handler(client, { expiry: '5y', confirm: true });
  assert.equal(badExpiry.isError, true);
  assert.deepEqual(calls, []);
});

test('registry_kubernetes_manifest: sends Accept: application/json as an extra header', async () => {
  const calls: Array<{ path: string; headers?: Record<string, string> }> = [];
  const client = {
    post: async (path: string, _body?: unknown, headers?: Record<string, string>) => {
      calls.push({ path, headers });
      return MANIFEST_RESPONSE;
    },
  } as unknown as RareCloudClient;
  await registryKubernetesManifest.handler(client, { confirm: true });
  assert.deepEqual(calls, [
    { path: '/v1/registry/docker-credentials/kubernetes', headers: { Accept: 'application/json' } },
  ]);
});

test('registry_kubernetes_manifest: the secret appears exactly once in the result, plus a once-only warning', async () => {
  const { client } = fakeWriteClient(() => MANIFEST_RESPONSE);
  const result = await registryKubernetesManifest.handler(client, { confirm: true });
  const text = textOf(result);
  const occurrences = text.split(MANIFEST_RESPONSE.secret).length - 1;
  assert.equal(occurrences, 1, 'the secret must appear exactly once in the result text');
  assert.match(text, /shown ONLY in this response and can never be retrieved again/i);
  // The manifest text itself is also carried through, once.
  assert.match(text, /kind: Secret/);
});

test('registry_kubernetes_manifest: the secret is never passed to console.log/warn/error', async () => {
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
    await registryKubernetesManifest.handler(client, { confirm: true });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.ok(!seen.some((s) => s.includes(MANIFEST_RESPONSE.secret)), 'the secret must never reach console.*');
});

// ---------------------------------------------------------------------------
// Fix round 1: registry_credentials_revoke and registry_tag_delete both hit
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

test('registry_credentials_revoke: a real 204 No Content response is a success, not INVALID_RESPONSE', async () => {
  const stub = stubRealFetch(new Response(null, { status: 204 }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const result = await registryCredentialsRevoke.handler(client, {
      id: '11111111-1111-1111-1111-111111111111',
      confirm: true,
    });
    assert.equal(result.isError, undefined, textOf(result));
  } finally {
    stub.restore();
  }
});

test('registry_tag_delete: a real 204 No Content response is a success, not INVALID_RESPONSE', async () => {
  const stub = stubRealFetch(new Response(null, { status: 204 }));
  try {
    const client = new RareCloudClient({ endpoint: 'https://example.com', token: 't' });
    const result = await registryTagDelete.handler(client, { repo: 'app', tag: '1.0', confirm: true });
    assert.equal(result.isError, undefined, textOf(result));
  } finally {
    stub.restore();
  }
});
