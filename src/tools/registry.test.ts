// Unit tests for the Container Registry READ tools (Plan 4 Task 5): account
// status, tiers, robot-credential metadata, repositories/tags/CVEs, and
// linked clusters. A fake client records the GET path (no network); we
// assert path construction (incl. encodeSegment on `repo`/`tag`, and the
// optional limit/cursor query-string idiom), closed schemas, JSON result
// shaping, and the uniform APIError -> errorResult mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registryGet,
  registryTiers,
  registryCredentialsList,
  registryRepositoriesList,
  registryRepositoryGet,
  registryRepositoryVulnerabilities,
  registryClustersList,
} from './registry.js';
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

// --- fixed-path list tools (registry_get / registry_tiers / registry_credentials_list / registry_clusters_list) ---

const FIXED_PATH_TOOLS: Array<{ tool: ToolDefinition; path: string }> = [
  { tool: registryGet, path: '/v1/registry' },
  { tool: registryTiers, path: '/v1/registry/tiers' },
  { tool: registryCredentialsList, path: '/v1/registry/credentials' },
  { tool: registryClustersList, path: '/v1/registry/clusters' },
];

test('registry reads: fixed-path tools have an empty closed schema and no scope literal in the description', () => {
  for (const { tool } of FIXED_PATH_TOOLS) {
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    // Matches this repo's existing convention: no read tool names a scope.
    assert.doesNotMatch(tool.description, /services:(read|write)/, `${tool.name} must not name a scope`);
  }
});

test('registry reads: fixed-path tools GET the expected path and JSON-encode the result', async () => {
  for (const { tool, path } of FIXED_PATH_TOOLS) {
    const { client, calls } = fakeClient(() => ({ ok: true, name: tool.name }));
    const result = await tool.handler(client, {});
    assert.deepEqual(calls, [path], `${tool.name} path`);
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(result)), { ok: true, name: tool.name });
  }
});

test('registry reads: fixed-path tools map APIError to errorResult', async () => {
  for (const { tool } of FIXED_PATH_TOOLS) {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'NOT_FOUND', message: 'The container registry is not enabled.' });
    });
    const result = await tool.handler(client, {});
    assert.equal(result.isError, true, `${tool.name} must map APIError`);
    assert.equal(textOf(result), 'Error: [NOT_FOUND] The container registry is not enabled.');
  }
});

// --- registry_get / registry_tiers specifics -------------------------------

test('registry_get: names registry_get and returns usage/quota/push/clusters verbatim', async () => {
  assert.equal(registryGet.name, 'registry_get');
  const payload = {
    handle: 'acme',
    hostname: 'registry.example.com',
    tier: 'free',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    usage: { logicalBytes: 1000, repoCount: 2, sampledAt: '2026-01-02T00:00:00.000Z' },
    quota: { quotaGb: 5, burstCeilingGb: 5, overageCentsPerGbMonth: 2 },
    push: { allowed: true, reason: 'ok' },
    clusters: { linked: 1, linkable: 2 },
  };
  const { client } = fakeClient(() => payload);
  const result = await registryGet.handler(client, {});
  assert.deepEqual(JSON.parse(textOf(result)), payload);
});

test('registry_tiers: names registry_tiers and returns the items array verbatim', async () => {
  assert.equal(registryTiers.name, 'registry_tiers');
  const payload = {
    items: [
      { tier: 'free', quotaGb: 1, burstCeilingGb: 1, monthlyCents: { EUR: 0, USD: 0 }, overageCentsPerGbMonth: 2, available: true },
      { tier: 'starter', quotaGb: 10, burstCeilingGb: 15, monthlyCents: { EUR: 500, USD: 550 }, overageCentsPerGbMonth: 2, available: true },
    ],
  };
  const { client } = fakeClient(() => payload);
  const result = await registryTiers.handler(client, {});
  assert.deepEqual(JSON.parse(textOf(result)), payload);
});

// --- registry_repositories_list (optional limit/cursor query) --------------

test('registry_repositories_list: name + schema advertises optional limit/cursor, closed', () => {
  assert.equal(registryRepositoriesList.name, 'registry_repositories_list');
  assert.equal(registryRepositoriesList.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(registryRepositoriesList.inputSchema.properties), ['limit', 'cursor']);
});

test('registry_repositories_list: no query params -> bare path', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await registryRepositoriesList.handler(client, {});
  assert.deepEqual(calls, ['/v1/registry/repositories']);
});

test('registry_repositories_list: forwards limit + cursor as query params', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await registryRepositoriesList.handler(client, { limit: 25, cursor: 'abc123' });
  assert.deepEqual(calls, ['/v1/registry/repositories?limit=25&cursor=abc123']);
});

test('registry_repositories_list: an empty-string cursor is dropped, not sent literally', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await registryRepositoriesList.handler(client, { cursor: '' });
  assert.deepEqual(calls, ['/v1/registry/repositories']);
});

// --- registry_repository_get (repo may contain '/') -------------------------

test('registry_repository_get: name + requires only repo (closed schema)', () => {
  assert.equal(registryRepositoryGet.name, 'registry_repository_get');
  assert.deepEqual(registryRepositoryGet.inputSchema.required, ['repo']);
  assert.equal(registryRepositoryGet.inputSchema.additionalProperties, false);
});

test('registry_repository_get: encodes a simple repo into the path', async () => {
  const { client, calls } = fakeClient(() => ({ path: 'app', name: 'app', tags: [] }));
  await registryRepositoryGet.handler(client, { repo: 'app' });
  assert.deepEqual(calls, ['/v1/registry/repositories/app']);
});

test('registry_repository_get: a repo containing "/" is encoded as one opaque segment', async () => {
  const { client, calls } = fakeClient(() => ({ path: 'team/app', name: 'team/app', tags: [] }));
  await registryRepositoryGet.handler(client, { repo: 'team/app' });
  assert.deepEqual(calls, ['/v1/registry/repositories/team%2Fapp']);
});

test('registry_repository_get: a ".." repo is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const result = await registryRepositoryGet.handler(client, { repo: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid repo value');
  assert.deepEqual(calls, []);
});

test('registry_repository_get: an embedded ".." (e.g. "a/../b") reaches the server as one opaque segment, not a path-traversal', async () => {
  const { client, calls } = fakeClient(() => ({}));
  await registryRepositoryGet.handler(client, { repo: 'a/../b' });
  // encodeURIComponent('a/../b') -> 'a%2F..%2Fb': the '..' is never a bare,
  // unescaped path segment, so URL dot-segment normalization cannot fire.
  // This reaches the server intact for ITS OCI-grammar validation to reject.
  assert.deepEqual(calls, ['/v1/registry/repositories/a%2F..%2Fb']);
});

test('registry_repository_get: APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'BACKEND_UNAVAILABLE', message: 'The container registry backend is temporarily unavailable.' });
  });
  const result = await registryRepositoryGet.handler(client, { repo: 'app' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [BACKEND_UNAVAILABLE] The container registry backend is temporarily unavailable.');
});

// --- registry_repository_vulnerabilities (repo + tag path, limit/cursor query) --

test('registry_repository_vulnerabilities: name + requires repo and tag (closed schema)', () => {
  assert.equal(registryRepositoryVulnerabilities.name, 'registry_repository_vulnerabilities');
  assert.deepEqual(registryRepositoryVulnerabilities.inputSchema.required, ['repo', 'tag']);
  assert.equal(registryRepositoryVulnerabilities.inputSchema.additionalProperties, false);
});

test('registry_repository_vulnerabilities: builds .../tags/{tag}/vulnerabilities with no query when omitted', async () => {
  const { client, calls } = fakeClient(() => ({ items: [], unavailable: false }));
  await registryRepositoryVulnerabilities.handler(client, { repo: 'app', tag: '1.0' });
  assert.deepEqual(calls, ['/v1/registry/repositories/app/tags/1.0/vulnerabilities']);
});

test('registry_repository_vulnerabilities: forwards limit + cursor', async () => {
  const { client, calls } = fakeClient(() => ({ items: [], unavailable: false }));
  await registryRepositoryVulnerabilities.handler(client, { repo: 'app', tag: '1.0', limit: 10, cursor: 'xyz' });
  assert.deepEqual(calls, ['/v1/registry/repositories/app/tags/1.0/vulnerabilities?limit=10&cursor=xyz']);
});

test('registry_repository_vulnerabilities: repo may contain "/" (encoded as one opaque segment)', async () => {
  const { client, calls } = fakeClient(() => ({ items: [], unavailable: false }));
  await registryRepositoryVulnerabilities.handler(client, { repo: 'team/app', tag: 'latest' });
  assert.deepEqual(calls, ['/v1/registry/repositories/team%2Fapp/tags/latest/vulnerabilities']);
});

test('registry_repository_vulnerabilities: a ".." repo or tag is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const badRepo = await registryRepositoryVulnerabilities.handler(client, { repo: '..', tag: '1.0' });
  assert.equal(textOf(badRepo), 'Error: Invalid repo value');
  const badTag = await registryRepositoryVulnerabilities.handler(client, { repo: 'app', tag: '..' });
  assert.equal(textOf(badTag), 'Error: Invalid tag value');
  assert.deepEqual(calls, []);
});

test('registry_repository_vulnerabilities: surfaces unavailable:true (scan disabled) verbatim, not as an error', async () => {
  const { client } = fakeClient(() => ({ items: [], nextCursor: undefined, unavailable: true }));
  const result = await registryRepositoryVulnerabilities.handler(client, { repo: 'app', tag: '1.0' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { items: [], unavailable: true });
});
