// Unit tests for the Parity Phase B managed-Kubernetes WRITE tools (Task 4):
// cluster scale, node-pool add/edit/delete/rename, HA enable, and the
// long-lived kubeconfig credential lifecycle (mint + revoke). A fake client
// records method+path+body (no network); we assert closed schemas, path +
// segment encoding, exact body shapes, the confirm/destructive gates, the
// traversal guards on EVERY dynamic segment, and — for create_cluster_kubeconfig
// — that the LIVE credential comes back as raw kubeconfig YAML (not the JSON
// envelope), errors when absent, and carries the treat-as-secret description.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setClusterScale,
  addClusterPool,
  updateClusterPool,
  deleteClusterPool,
  renameClusterPool,
  enableClusterHa,
  createClusterKubeconfig,
  revokeClusterKubeconfig,
} from './k8s-write.js';
import { APIError, type RareCloudClient } from '../client.js';
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

// An obviously-fake kubeconfig fixture (public repo hygiene): unroutable
// server + placeholder token. Must never resemble a real credential.
const FAKE_KUBECONFIG = [
  'apiVersion: v1',
  'kind: Config',
  'clusters:',
  '- name: fake-cluster',
  '  cluster:',
  '    server: https://example.invalid:6443',
  'users:',
  '- name: fake-user',
  '  user:',
  '    token: fake-token',
  'contexts:',
  '- name: fake',
  '  context:',
  '    cluster: fake-cluster',
  '    user: fake-user',
  'current-context: fake',
].join('\n');

// ---------------------------------------------------------------------------
// Shared table: each tool with its gate flags, a set of minimal valid DOMAIN
// args (excluding service_id and the factory-owned confirm), and the name of a
// SECOND dynamic path segment (pool / credential_id) when the tool has one.
// Drives the registry / gate / traversal assertions below.
// ---------------------------------------------------------------------------
type NewToolCase = {
  tool: ToolDefinition;
  gated: boolean; // advertises confirm
  destructive: boolean; // advertises annotations.destructiveHint
  secondSeg?: 'pool' | 'credential_id';
  args: Record<string, unknown>; // required domain args minus service_id (incl. the 2nd segment)
};

const NEW_TOOLS: Record<string, NewToolCase> = {
  set_cluster_scale: { tool: setClusterScale, gated: false, destructive: false, args: { minimum: 1, maximum: 3 } },
  add_cluster_pool: { tool: addClusterPool, gated: true, destructive: false, args: { name: 'workers', minimum: 1, maximum: 3 } },
  update_cluster_pool: { tool: updateClusterPool, gated: false, destructive: false, secondSeg: 'pool', args: { pool: 'default' } },
  delete_cluster_pool: { tool: deleteClusterPool, gated: true, destructive: true, secondSeg: 'pool', args: { pool: 'default' } },
  rename_cluster_pool: { tool: renameClusterPool, gated: false, destructive: false, secondSeg: 'pool', args: { pool: 'default', name: 'newname' } },
  enable_cluster_ha: { tool: enableClusterHa, gated: true, destructive: false, args: {} },
  create_cluster_kubeconfig: { tool: createClusterKubeconfig, gated: false, destructive: false, args: { name: 'ci', role: 'admin' } },
  revoke_cluster_kubeconfig: { tool: revokeClusterKubeconfig, gated: true, destructive: true, secondSeg: 'credential_id', args: { credential_id: 'cred-1' } },
};

test('task4 registry: each tool has its name, closed schema, requires service_id, services:write in description', () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.match(c.tool.description, /services:write/, `${name} description must name the scope`);
    assert.ok(
      (c.tool.inputSchema.required ?? []).includes('service_id'),
      `${name} must require service_id`,
    );
  }
});

test('task4 gates: confirm advertised iff gated; destructiveHint iff destructive', () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    const hasConfirm = 'confirm' in c.tool.inputSchema.properties;
    assert.equal(hasConfirm, c.gated, `${name}: confirm-in-schema must match gated=${c.gated}`);
    if (c.gated) {
      assert.ok(
        (c.tool.inputSchema.required ?? []).includes('confirm'),
        `${name}: gated tool must require confirm`,
      );
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

test('task4 second segment: tools with a 2nd path segment require it', () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    if (!c.secondSeg) continue;
    assert.ok(
      (c.tool.inputSchema.required ?? []).includes(c.secondSeg),
      `${name} must require ${c.secondSeg}`,
    );
  }
});

test('task4 confirm gate: gated tools refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { service_id: 'svc-1', ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('task4 traversal guard: a ".." service_id is rejected before any request', async () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { service_id: '..', ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid service_id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

test('task4 traversal guard: a ".." second segment (pool / credential_id) is rejected before any request', async () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    if (!c.secondSeg) continue;
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const badSeg = { ...c.args, [c.secondSeg]: '..' };
    const result = await c.tool.handler(client, { service_id: 'svc-1', ...badSeg, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject a ".." ${c.secondSeg}`);
    assert.equal(textOf(result), `Error: Invalid ${c.secondSeg} value`, `${name} ${c.secondSeg} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for a ".." ${c.secondSeg}`);
  }
});

test('task4 APIError mapping: a representative tool maps [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await setClusterScale.handler(client, { service_id: 'srv-1', minimum: 1, maximum: 2 });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});

// --- set_cluster_scale (POST {minimum,maximum}, no gate) -------------------

test('set_cluster_scale: POSTs {minimum,maximum} to /scale (no confirm gate)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setClusterScale.handler(client, { service_id: 'svc 1/2', minimum: 2, maximum: 5 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/svc%201%2F2/scale', body: { minimum: 2, maximum: 5 } },
  ]);
});

test('set_cluster_scale: rejects a non-integer minimum before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setClusterScale.handler(client, { service_id: 's1', minimum: 1.5, maximum: 5 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_cluster_scale:/);
  assert.deepEqual(calls, []);
});

test('set_cluster_scale: rejects a minimum below 1 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setClusterScale.handler(client, { service_id: 's1', minimum: 0, maximum: 5 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_cluster_scale:/);
  assert.deepEqual(calls, []);
});

// --- add_cluster_pool (POST, confirm — money-spend) -----------------------

test('add_cluster_pool: POSTs required fields to /pools when confirmed (optionals omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addClusterPool.handler(client, {
    service_id: 's1',
    name: 'workers',
    minimum: 1,
    maximum: 3,
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/pools', body: { name: 'workers', minimum: 1, maximum: 3 } },
  ]);
});

test('add_cluster_pool: forwards optional machineType + volumeSizeGb when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addClusterPool.handler(client, {
    service_id: 's1',
    name: 'gpu',
    minimum: 1,
    maximum: 2,
    machineType: 'c-4vcpu-8gb',
    volumeSizeGb: 100,
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/services/s1/pools',
      body: { name: 'gpu', minimum: 1, maximum: 2, machineType: 'c-4vcpu-8gb', volumeSizeGb: 100 },
    },
  ]);
});

test('add_cluster_pool: rejects an out-of-range volumeSizeGb before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addClusterPool.handler(client, {
    service_id: 's1',
    name: 'workers',
    minimum: 1,
    maximum: 3,
    volumeSizeGb: 5,
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_cluster_pool:/);
  assert.deepEqual(calls, []);
});

// --- update_cluster_pool (PATCH, only-provided keys reach the body) --------

test('update_cluster_pool: PATCHes only the provided key to /pools/{pool}', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateClusterPool.handler(client, { service_id: 's1', pool: 'default', maximum: 5 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PATCH', path: '/v1/services/s1/pools/default', body: { maximum: 5 } },
  ]);
});

test('update_cluster_pool: forwards all four optionals when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateClusterPool.handler(client, {
    service_id: 's1',
    pool: 'default',
    minimum: 2,
    maximum: 6,
    machineType: 'c-2vcpu-4gb',
    volumeSizeGb: 50,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'PATCH',
      path: '/v1/services/s1/pools/default',
      body: { minimum: 2, maximum: 6, machineType: 'c-2vcpu-4gb', volumeSizeGb: 50 },
    },
  ]);
});

test('update_cluster_pool: an empty edit sends an empty body (only service_id + pool provided)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateClusterPool.handler(client, { service_id: 's1', pool: 'default' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PATCH', path: '/v1/services/s1/pools/default', body: {} }]);
});

// --- delete_cluster_pool (DELETE, no body, confirm+destr) ------------------

test('delete_cluster_pool: DELETEs /pools/{pool} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteClusterPool.handler(client, { service_id: 's1', pool: 'gpu/1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/services/s1/pools/gpu%2F1' }]);
});

// --- rename_cluster_pool (POST {name}, no gate) ----------------------------

test('rename_cluster_pool: POSTs {name} to /pools/{pool}/rename', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await renameClusterPool.handler(client, { service_id: 's1', pool: 'default', name: 'primary' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/pools/default/rename', body: { name: 'primary' } },
  ]);
});

test('rename_cluster_pool: rejects a name over 64 chars before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await renameClusterPool.handler(client, { service_id: 's1', pool: 'default', name: 'x'.repeat(65) });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for rename_cluster_pool:/);
  assert.deepEqual(calls, []);
});

// --- enable_cluster_ha (POST, no body, confirm — money-spend) --------------

test('enable_cluster_ha: POSTs /high-availability with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await enableClusterHa.handler(client, { service_id: 's1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/high-availability', body: undefined }]);
});

// --- create_cluster_kubeconfig (mints a LIVE credential; raw YAML out) -----

test('create_cluster_kubeconfig: POSTs {name,role} to /kubeconfigs and returns the raw YAML (not the JSON envelope)', async () => {
  const { client, calls } = fakeWriteClient(() => ({ id: 'cred-1', kubeconfig: FAKE_KUBECONFIG }));
  const result = await createClusterKubeconfig.handler(client, { service_id: 's1', name: 'ci', role: 'admin' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/kubeconfigs', body: { name: 'ci', role: 'admin' } },
  ]);
  // Raw kubeconfig YAML, verbatim — NOT a JSON.stringify of the envelope.
  assert.equal(textOf(result), FAKE_KUBECONFIG);
  assert.ok(!textOf(result).trimStart().startsWith('{'), 'must not be a JSON-wrapped object');
});

test('create_cluster_kubeconfig: forwards the ttl enum when supplied', async () => {
  const { client, calls } = fakeWriteClient(() => ({ kubeconfig: FAKE_KUBECONFIG }));
  const result = await createClusterKubeconfig.handler(client, {
    service_id: 's1',
    name: 'gitops',
    role: 'view',
    ttl: '1y',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/kubeconfigs', body: { name: 'gitops', role: 'view', ttl: '1y' } },
  ]);
});

test('create_cluster_kubeconfig: a missing kubeconfig field is an error, not an empty text block', async () => {
  const { client, calls } = fakeWriteClient(() => ({ id: 'cred-1' })); // envelope with no `kubeconfig`
  const result = await createClusterKubeconfig.handler(client, { service_id: 's1', name: 'ci', role: 'admin' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: API returned no kubeconfig');
  // The request WAS made (unlike a validation refusal) — the credential just came back empty.
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/kubeconfigs', body: { name: 'ci', role: 'admin' } },
  ]);
});

test('create_cluster_kubeconfig: rejects an out-of-enum role before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createClusterKubeconfig.handler(client, { service_id: 's1', name: 'ci', role: 'edit' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_cluster_kubeconfig:/);
  assert.deepEqual(calls, []);
});

// ttl is a 4-value enum (30d|90d|1y|never) — verified against console
// openapi.json AND the route source (v1-services.ts KubeconfigCreateBody). The
// task-4 brief exemplar's free-form `ttl: z.string()` (e.g. "720h") is stale;
// reality wins, so a non-enum ttl must be rejected client-side.
test('create_cluster_kubeconfig: rejects a non-enum ttl before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createClusterKubeconfig.handler(client, {
    service_id: 's1',
    name: 'ci',
    role: 'admin',
    ttl: '720h',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_cluster_kubeconfig:/);
  assert.deepEqual(calls, []);
});

// Secret hygiene: the credential-minting tool's description must carry the same
// treat-as-secret guidance as the other credential-returning tools
// (get_cluster_kubeconfig, download_cluster_kubeconfig, get_proxy_auth).
test('create_cluster_kubeconfig: description flags the live secret + long-lived nature', () => {
  assert.match(createClusterKubeconfig.description, /secret/i);
  assert.match(createClusterKubeconfig.description, /do not echo/i);
  assert.match(createClusterKubeconfig.description, /long-lived/i);
});

// --- revoke_cluster_kubeconfig (DELETE, no body, confirm+destr) ------------

test('revoke_cluster_kubeconfig: DELETEs /kubeconfigs/{credential_id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await revokeClusterKubeconfig.handler(client, { service_id: 's1', credential_id: 'cred-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/services/s1/kubeconfigs/cred-1' }]);
});
