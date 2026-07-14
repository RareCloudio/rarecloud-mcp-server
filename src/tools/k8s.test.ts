// Unit tests for the Managed Kubernetes read tools added in Parity Phase A /
// Task 4 (cluster scale, node pools, short-lived admin kubeconfig, long-lived
// credential list + re-download). A fake client records the constructed path
// and returns a canned payload — no network.
//
// Two of these tools (get_cluster_kubeconfig, download_cluster_kubeconfig)
// return a LIVE credential. The API delivers it as JSON ({kubeconfig, ...});
// the tool must unwrap `data.kubeconfig` and emit the raw YAML as a plain-text
// content block, NOT the JSON-stringified envelope. These tests pin that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClusterScale,
  listClusterPools,
  getClusterKubeconfig,
  listClusterKubeconfigs,
  downloadClusterKubeconfig,
} from './k8s.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

function fakeClient(onGet: (path: string) => unknown): { client: RareCloudClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async get(path: string) {
      calls.push(path);
      return onGet(path);
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

// --- JSON single-id reads (scale, pools, long-lived credential list) -------
// [tool, name, suffix] — path is /v1/services/{service_id}{suffix}, JSON out.
const jsonIdScoped: Array<[ToolDefinition, string, string]> = [
  [getClusterScale, 'get_cluster_scale', '/scale'],
  [listClusterPools, 'list_cluster_pools', '/pools'],
  [listClusterKubeconfigs, 'list_cluster_kubeconfigs', '/kubeconfigs'],
];

for (const [tool, name, suffix] of jsonIdScoped) {
  test(`k8s: ${name} — encodes service_id into ${suffix}`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    const { client, calls } = fakeClient(() => ({ ok: true }));
    await tool.handler(client, { service_id: 'svc 1/2' });
    assert.deepEqual(calls, [`/v1/services/svc%201%2F2${suffix}`]);
  });

  test(`k8s: ${name} — requires service_id (closed schema, only service_id)`, () => {
    assert.deepEqual(tool.inputSchema.required, ['service_id']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['service_id']);
  });

  test(`k8s: ${name} — returns the payload as JSON text`, async () => {
    const { client } = fakeClient(() => ({ pools: [{ name: 'default', count: 3 }] }));
    const result = await tool.handler(client, { service_id: 'svc-123' });
    assert.equal(result.isError, undefined);
    // JSON tools stringify the envelope data — round-trips back to the object.
    assert.deepEqual(JSON.parse(textOf(result)), { pools: [{ name: 'default', count: 3 }] });
  });

  test(`k8s: ${name} — APIError maps to errorResult`, async () => {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'NOT_FOUND', message: 'no such cluster' });
    });
    const result = await tool.handler(client, { service_id: 'svc-123' });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: [NOT_FOUND] no such cluster');
  });
}

// --- dot-segment guard (path-traversal hardening, pre-Phase-B) -------------
// service_id flows into a URL path segment. A "." / ".." / empty value must be
// rejected BEFORE any request goes out — covers a readTool-based tool
// (get_cluster_scale) and a hand-written k8s handler (get_cluster_kubeconfig).

test('k8s: get_cluster_scale — a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({ ok: true }));
  const result = await getClusterScale.handler(client, { service_id: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." service_id');
});

test('k8s: get_cluster_kubeconfig — a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({ kubeconfig: FAKE_KUBECONFIG }));
  const result = await getClusterKubeconfig.handler(client, { service_id: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." service_id');
});

test('k8s: download_cluster_kubeconfig — a ".." credential_id is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({ kubeconfig: FAKE_KUBECONFIG }));
  const result = await downloadClusterKubeconfig.handler(client, { service_id: 'svc-123', credential_id: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid credential_id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." credential_id');
});

// --- get_cluster_kubeconfig (short-lived admin, live secret, raw text) -----

test('k8s: get_cluster_kubeconfig — encodes service_id into /kubeconfig', async () => {
  assert.equal(getClusterKubeconfig.name, 'get_cluster_kubeconfig');
  const { client, calls } = fakeClient(() => ({ kubeconfig: FAKE_KUBECONFIG, expiresAt: '2026-07-13T12:00:00Z' }));
  await getClusterKubeconfig.handler(client, { service_id: 'svc 1/2' });
  assert.deepEqual(calls, ['/v1/services/svc%201%2F2/kubeconfig']);
});

test('k8s: get_cluster_kubeconfig — requires service_id (closed schema)', () => {
  assert.deepEqual(getClusterKubeconfig.inputSchema.required, ['service_id']);
  assert.equal(getClusterKubeconfig.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(getClusterKubeconfig.inputSchema.properties), ['service_id']);
});

test('k8s: get_cluster_kubeconfig — returns the raw kubeconfig YAML as text, NOT the JSON envelope', async () => {
  const { client } = fakeClient(() => ({ kubeconfig: FAKE_KUBECONFIG, expiresAt: '2026-07-13T12:00:00Z' }));
  const result = await getClusterKubeconfig.handler(client, { service_id: 'svc-123' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  // Verbatim YAML — exactly what kubectl expects, no JSON wrapping.
  assert.equal(textOf(result), FAKE_KUBECONFIG);
  // Guard: the JSON envelope fields must NOT leak into the text block.
  assert.ok(!textOf(result).includes('expiresAt'), 'must not include envelope metadata');
  assert.ok(!textOf(result).startsWith('{'), 'must not be a JSON-stringified object');
});

test('k8s: get_cluster_kubeconfig — description flags it as a live secret + short-lived', () => {
  assert.match(getClusterKubeconfig.description, /secret/i);
  assert.match(getClusterKubeconfig.description, /do not echo/i);
  assert.match(getClusterKubeconfig.description, /short-lived/i);
});

test('k8s: get_cluster_kubeconfig — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'not your cluster' });
  });
  const result = await getClusterKubeconfig.handler(client, { service_id: 'svc-123' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] not your cluster');
});

test('k8s: get_cluster_kubeconfig — missing kubeconfig field is an error, not an empty text block', async () => {
  const { client } = fakeClient(() => ({})); // envelope with no `kubeconfig`
  const result = await getClusterKubeconfig.handler(client, { service_id: 'svc-123' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: API returned no kubeconfig');
});

// --- download_cluster_kubeconfig (long-lived, active-only, live secret) ----

test('k8s: download_cluster_kubeconfig — encodes service_id + credential_id into the download path', async () => {
  assert.equal(downloadClusterKubeconfig.name, 'download_cluster_kubeconfig');
  const { client, calls } = fakeClient(() => ({ kubeconfig: FAKE_KUBECONFIG, name: 'ci', expiresAt: null }));
  await downloadClusterKubeconfig.handler(client, { service_id: 'svc 1/2', credential_id: 'cred/uuid 1' });
  assert.deepEqual(calls, ['/v1/services/svc%201%2F2/kubeconfigs/cred%2Fuuid%201/download']);
});

test('k8s: download_cluster_kubeconfig — requires service_id + credential_id (closed schema)', () => {
  assert.deepEqual(downloadClusterKubeconfig.inputSchema.required, ['service_id', 'credential_id']);
  assert.equal(downloadClusterKubeconfig.inputSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(downloadClusterKubeconfig.inputSchema.properties).sort(),
    ['credential_id', 'service_id'],
  );
});

test('k8s: download_cluster_kubeconfig — returns the raw kubeconfig YAML as text, NOT the JSON envelope', async () => {
  const { client } = fakeClient(() => ({ kubeconfig: FAKE_KUBECONFIG, name: 'ci', expiresAt: null }));
  const result = await downloadClusterKubeconfig.handler(client, { service_id: 'svc-123', credential_id: 'cred-uuid-1' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(textOf(result), FAKE_KUBECONFIG);
  assert.ok(!textOf(result).includes('"name"'), 'must not include envelope metadata');
  assert.ok(!textOf(result).startsWith('{'), 'must not be a JSON-stringified object');
});

test('k8s: download_cluster_kubeconfig — description flags live secret, long-lived, active-only', () => {
  assert.match(downloadClusterKubeconfig.description, /secret/i);
  assert.match(downloadClusterKubeconfig.description, /do not echo/i);
  assert.match(downloadClusterKubeconfig.description, /long-lived/i);
  assert.match(downloadClusterKubeconfig.description, /active/i);
});

test('k8s: download_cluster_kubeconfig — APIError (revoked/expired) maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'GONE', message: 'credential revoked' });
  });
  const result = await downloadClusterKubeconfig.handler(client, { service_id: 'svc-123', credential_id: 'cred-uuid-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [GONE] credential revoked');
});

test('k8s: download_cluster_kubeconfig — missing kubeconfig field is an error, not an empty text block', async () => {
  const { client } = fakeClient(() => ({})); // envelope with no `kubeconfig`
  const result = await downloadClusterKubeconfig.handler(client, { service_id: 'svc-123', credential_id: 'cred-uuid-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: API returned no kubeconfig');
});

// --- list_cluster_kubeconfigs description guard ----------------------------

test('k8s: list_cluster_kubeconfigs description says the token is never returned here', () => {
  assert.match(listClusterKubeconfigs.description, /long-lived/i);
  assert.match(listClusterKubeconfigs.description, /never/i);
});
