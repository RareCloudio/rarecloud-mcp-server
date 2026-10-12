// Unit tests for the Container Registry READ tools (Plan 4 Task 5): account
// status, tiers, robot-credential metadata, repositories/tags/CVEs, and
// linked clusters. A fake client records the GET path (no network); we
// assert path construction (incl. encodeSegment on `repo`/`tag`, and the
// optional limit/cursor query-string idiom), closed schemas, JSON result
// shaping, and the uniform APIError -> errorResult mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getRegistry,
  listRegistryTiers,
  suggestRegistryHandle,
  listRegistryCredentials,
  listRegistryRepositories,
  getRegistryRepository,
  listRegistryTagVulnerabilities,
  listRegistryClusters,
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

// --- fixed-path list tools (get_registry / list_registry_tiers / list_registry_clusters) ---

const FIXED_PATH_TOOLS: Array<{ tool: ToolDefinition; path: string }> = [
  { tool: getRegistry, path: '/v1/registry' },
  { tool: listRegistryTiers, path: '/v1/registry/tiers' },
  { tool: listRegistryClusters, path: '/v1/registry/clusters' },
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

// --- get_registry / list_registry_tiers specifics -------------------------------

test('get_registry: names get_registry and returns usage/quota/push/clusters verbatim', async () => {
  assert.equal(getRegistry.name, 'get_registry');
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
  const result = await getRegistry.handler(client, {});
  assert.deepEqual(JSON.parse(textOf(result)), payload);
});

test('list_registry_tiers: names list_registry_tiers and returns the items array verbatim', async () => {
  assert.equal(listRegistryTiers.name, 'list_registry_tiers');
  const payload = {
    items: [
      { tier: 'free', quotaGb: 1, burstCeilingGb: 1, monthlyCents: { EUR: 0, USD: 0 }, overageCentsPerGbMonth: 2, available: true },
      { tier: 'starter', quotaGb: 10, burstCeilingGb: 15, monthlyCents: { EUR: 500, USD: 550 }, overageCentsPerGbMonth: 2, available: true },
    ],
  };
  const { client } = fakeClient(() => payload);
  const result = await listRegistryTiers.handler(client, {});
  assert.deepEqual(JSON.parse(textOf(result)), payload);
});

test('get_registry: description says usage is the hourly sample and explains the repository cap', () => {
  assert.match(getRegistry.description, /HOURLY metering sample/);
  assert.match(getRegistry.description, /repo_limit/);
  assert.match(getRegistry.description, /NEW repository is refused while pushes to existing ones keep working/);
  assert.match(getRegistry.description, /push\.repoCount\), not usage\.repoCount/);
});

// --- list_registry_credentials (optional `status` filter) -------------------

test('list_registry_credentials: schema advertises an optional status enum ["active"], closed', () => {
  assert.equal(listRegistryCredentials.name, 'list_registry_credentials');
  assert.equal(listRegistryCredentials.inputSchema.additionalProperties, false);
  assert.equal(listRegistryCredentials.inputSchema.required, undefined);
  const props = listRegistryCredentials.inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(Object.keys(props), ['status']);
  assert.deepEqual(props.status.enum, ['active']);
  assert.doesNotMatch(listRegistryCredentials.description, /services:(read|write)/, 'must not name a scope');
});

test('list_registry_credentials: no status -> bare path (every credential, revoked included)', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  const result = await listRegistryCredentials.handler(client, {});
  assert.deepEqual(calls, ['/v1/registry/credentials']);
  assert.equal(result.isError, undefined);
});

test('list_registry_credentials: status "active" is forwarded as ?status=active', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await listRegistryCredentials.handler(client, { status: 'active' });
  assert.deepEqual(calls, ['/v1/registry/credentials?status=active']);
});

test('list_registry_credentials: an empty-string status is dropped, not sent literally', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await listRegistryCredentials.handler(client, { status: '' });
  assert.deepEqual(calls, ['/v1/registry/credentials']);
});

test('list_registry_credentials: maps APIError to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'INVALID_PARAM', message: 'status must be active.' });
  });
  const result = await listRegistryCredentials.handler(client, { status: 'active' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [INVALID_PARAM] status must be active.');
});

// --- suggest_registry_handle (optional `base` query) ------------------------

test('suggest_registry_handle: name + schema advertises an optional base, closed, nothing required', () => {
  assert.equal(suggestRegistryHandle.name, 'suggest_registry_handle');
  assert.equal(suggestRegistryHandle.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(suggestRegistryHandle.inputSchema.properties), ['base']);
  assert.equal(suggestRegistryHandle.inputSchema.required, undefined);
  assert.doesNotMatch(suggestRegistryHandle.description, /services:(read|write)/, 'must not name a scope');
});

test('suggest_registry_handle: no base given -> bare path', async () => {
  const { client, calls } = fakeClient(() => ({ suggestions: [] }));
  await suggestRegistryHandle.handler(client, {});
  assert.deepEqual(calls, ['/v1/registry/handles/suggest']);
});

test('suggest_registry_handle: forwards base as a query param', async () => {
  const { client, calls } = fakeClient(() => ({ suggestions: ['acme01', 'acme02', 'acme03'] }));
  await suggestRegistryHandle.handler(client, { base: 'acme' });
  assert.deepEqual(calls, ['/v1/registry/handles/suggest?base=acme']);
});

test('suggest_registry_handle: an empty-string base is dropped, not sent literally', async () => {
  const { client, calls } = fakeClient(() => ({ suggestions: [] }));
  await suggestRegistryHandle.handler(client, { base: '' });
  assert.deepEqual(calls, ['/v1/registry/handles/suggest']);
});

test('suggest_registry_handle: a base needing URL-encoding is escaped (space, punctuation)', async () => {
  const { client, calls } = fakeClient(() => ({ suggestions: [] }));
  await suggestRegistryHandle.handler(client, { base: 'my app!' });
  assert.deepEqual(calls, ['/v1/registry/handles/suggest?base=my+app%21']);
});

test('suggest_registry_handle: returns the suggestions array verbatim', async () => {
  const payload = { suggestions: ['bluefalcon42', 'redotter17'] };
  const { client } = fakeClient(() => payload);
  const result = await suggestRegistryHandle.handler(client, {});
  assert.deepEqual(JSON.parse(textOf(result)), payload);
});

// --- list_registry_repositories (optional limit/cursor query) --------------

test('list_registry_repositories: name + schema advertises optional limit/cursor, closed', () => {
  assert.equal(listRegistryRepositories.name, 'list_registry_repositories');
  assert.equal(listRegistryRepositories.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(listRegistryRepositories.inputSchema.properties), ['limit', 'cursor']);
});

test('list_registry_repositories: no query params -> bare path', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await listRegistryRepositories.handler(client, {});
  assert.deepEqual(calls, ['/v1/registry/repositories']);
});

test('list_registry_repositories: forwards limit + cursor as query params', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await listRegistryRepositories.handler(client, { limit: 25, cursor: 'abc123' });
  assert.deepEqual(calls, ['/v1/registry/repositories?limit=25&cursor=abc123']);
});

test('list_registry_repositories: an empty-string cursor is dropped, not sent literally', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  await listRegistryRepositories.handler(client, { cursor: '' });
  assert.deepEqual(calls, ['/v1/registry/repositories']);
});

// --- get_registry_repository (repo may contain '/') -------------------------

test('get_registry_repository: name + requires only repo (closed schema)', () => {
  assert.equal(getRegistryRepository.name, 'get_registry_repository');
  assert.deepEqual(getRegistryRepository.inputSchema.required, ['repo']);
  assert.equal(getRegistryRepository.inputSchema.additionalProperties, false);
});

test('get_registry_repository: encodes a simple repo into the path', async () => {
  const { client, calls } = fakeClient(() => ({ path: 'app', name: 'app', tags: [] }));
  await getRegistryRepository.handler(client, { repo: 'app' });
  assert.deepEqual(calls, ['/v1/registry/repositories/app']);
});

test('get_registry_repository: a repo containing "/" is encoded as one opaque segment', async () => {
  const { client, calls } = fakeClient(() => ({ path: 'team/app', name: 'team/app', tags: [] }));
  await getRegistryRepository.handler(client, { repo: 'team/app' });
  assert.deepEqual(calls, ['/v1/registry/repositories/team%2Fapp']);
});

test('get_registry_repository: a ".." repo is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const result = await getRegistryRepository.handler(client, { repo: '..' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid repo value');
  assert.deepEqual(calls, []);
});

test('get_registry_repository: an embedded ".." (e.g. "a/../b") reaches the server as one opaque segment, not a path-traversal', async () => {
  const { client, calls } = fakeClient(() => ({}));
  await getRegistryRepository.handler(client, { repo: 'a/../b' });
  // encodeURIComponent('a/../b') -> 'a%2F..%2Fb': the '..' is never a bare,
  // unescaped path segment, so URL dot-segment normalization cannot fire.
  // This reaches the server intact for ITS OCI-grammar validation to reject.
  assert.deepEqual(calls, ['/v1/registry/repositories/a%2F..%2Fb']);
});

test('get_registry_repository: APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'BACKEND_UNAVAILABLE', message: 'The container registry backend is temporarily unavailable.' });
  });
  const result = await getRegistryRepository.handler(client, { repo: 'app' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [BACKEND_UNAVAILABLE] The container registry backend is temporarily unavailable.');
});

// --- list_registry_tag_vulnerabilities (repo + tag path, limit/cursor query) --

test('list_registry_tag_vulnerabilities: name + requires repo and tag (closed schema)', () => {
  assert.equal(listRegistryTagVulnerabilities.name, 'list_registry_tag_vulnerabilities');
  assert.deepEqual(listRegistryTagVulnerabilities.inputSchema.required, ['repo', 'tag']);
  assert.equal(listRegistryTagVulnerabilities.inputSchema.additionalProperties, false);
});

test('list_registry_tag_vulnerabilities: builds .../tags/{tag}/vulnerabilities with no query when omitted', async () => {
  const { client, calls } = fakeClient(() => ({ items: [], unavailable: false }));
  await listRegistryTagVulnerabilities.handler(client, { repo: 'app', tag: '1.0' });
  assert.deepEqual(calls, ['/v1/registry/repositories/app/tags/1.0/vulnerabilities']);
});

test('list_registry_tag_vulnerabilities: forwards limit + cursor', async () => {
  const { client, calls } = fakeClient(() => ({ items: [], unavailable: false }));
  await listRegistryTagVulnerabilities.handler(client, { repo: 'app', tag: '1.0', limit: 10, cursor: 'xyz' });
  assert.deepEqual(calls, ['/v1/registry/repositories/app/tags/1.0/vulnerabilities?limit=10&cursor=xyz']);
});

test('list_registry_tag_vulnerabilities: repo may contain "/" (encoded as one opaque segment)', async () => {
  const { client, calls } = fakeClient(() => ({ items: [], unavailable: false }));
  await listRegistryTagVulnerabilities.handler(client, { repo: 'team/app', tag: 'latest' });
  assert.deepEqual(calls, ['/v1/registry/repositories/team%2Fapp/tags/latest/vulnerabilities']);
});

test('list_registry_tag_vulnerabilities: a ".." repo or tag is rejected before any request', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const badRepo = await listRegistryTagVulnerabilities.handler(client, { repo: '..', tag: '1.0' });
  assert.equal(textOf(badRepo), 'Error: Invalid repo value');
  const badTag = await listRegistryTagVulnerabilities.handler(client, { repo: 'app', tag: '..' });
  assert.equal(textOf(badTag), 'Error: Invalid tag value');
  assert.deepEqual(calls, []);
});

test('list_registry_tag_vulnerabilities: surfaces unavailable:true (scan disabled) verbatim, not as an error', async () => {
  const { client } = fakeClient(() => ({ items: [], nextCursor: undefined, unavailable: true }));
  const result = await listRegistryTagVulnerabilities.handler(client, { repo: 'app', tag: '1.0' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { items: [], unavailable: true });
});

// --- contract notes the descriptions must carry ------------------------------

test('list_registry_repositories: name (not path) is the repo argument; lastPush is the build time', () => {
  assert.match(listRegistryRepositories.description, /`name` never carries the handle/);
  assert.match(listRegistryRepositories.description, /`path` is the full `<handle>\/<name>`/);
  assert.match(listRegistryRepositories.description, /lastPush is a deprecated name/);
  assert.match(listRegistryRepositories.description, /BUILD time/);
});

test('get_registry_repository: createdAt is the build time and pushedAt a deprecated alias of it', () => {
  assert.match(getRegistryRepository.description, /createdAt is when the image was BUILT/);
  assert.match(getRegistryRepository.description, /pushedAt is a deprecated alias that always equals createdAt/);
  assert.match(getRegistryRepository.description, /delete_registry_manifest/);
});

test('list_registry_clusters: mentions credentialName (never the secret)', () => {
  assert.match(listRegistryClusters.description, /credentialName/);
});
