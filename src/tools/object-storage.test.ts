// Unit tests for the Object Storage tools: the service account (get / enable /
// disable), regions, account usage, buckets (list / get / create / update /
// delete / usage) and S3 access keys (list / create / revoke). A fake client
// records method + path + body (no network); we assert paths, query strings,
// exact body shapes (omit-undefined optionals), closed schemas, the confirm
// gate, the secret marking on key creation, and the traversal guard on every
// dynamic id segment. Shapes mirror api/src/routes/v1-object-storage.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getObjectStorage,
  listObjectStorageRegions,
  getObjectStorageUsage,
  listBuckets,
  getBucket,
  getBucketUsage,
  listObjectStorageKeys,
} from './object-storage.js';
import {
  enableObjectStorage,
  disableObjectStorage,
  createBucket,
  updateBucket,
  deleteBucket,
  createObjectStorageKey,
  deleteObjectStorageKey,
} from './object-storage-write.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

type Call = { method: string; path: string; body?: unknown };

function fakeClient(
  impl: (m: string, p: string, b?: unknown) => unknown = () => ({ ok: true }),
): { client: RareCloudClient; calls: Call[] } {
  const calls: Call[] = [];
  const withBody = (method: string) => async (path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return impl(method, path, body);
  };
  const client = {
    get: withBody('GET'),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    delete: withBody('DELETE'),
  } as unknown as RareCloudClient;
  return { client, calls };
}

function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

const BUCKET = '11111111-2222-4333-8444-555555555555';
const KEY = '66666666-7777-4888-9999-aaaaaaaaaaaa';

// --- reads ------------------------------------------------------------------

const READS: Array<[ToolDefinition, string, Record<string, unknown>, string]> = [
  [getObjectStorage, 'get_object_storage', {}, '/v1/object-storage'],
  [listObjectStorageRegions, 'list_object_storage_regions', {}, '/v1/object-storage/regions'],
  [getObjectStorageUsage, 'get_object_storage_usage', {}, '/v1/object-storage/usage'],
  [getObjectStorageUsage, 'get_object_storage_usage', { days: 7 }, '/v1/object-storage/usage?days=7'],
  [listBuckets, 'list_buckets', {}, '/v1/object-storage/buckets'],
  [getBucket, 'get_bucket', { id: BUCKET }, `/v1/object-storage/buckets/${BUCKET}`],
  [getBucketUsage, 'get_bucket_usage', { id: BUCKET }, `/v1/object-storage/buckets/${BUCKET}/usage`],
  [getBucketUsage, 'get_bucket_usage', { id: BUCKET, days: 90 }, `/v1/object-storage/buckets/${BUCKET}/usage?days=90`],
  [listObjectStorageKeys, 'list_object_storage_keys', {}, '/v1/object-storage/keys'],
];

for (const [tool, name, args, path] of READS) {
  test(`object storage read: ${name} ${JSON.stringify(args)} GETs ${path}`, async () => {
    assert.equal(tool.name, name);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} is a read`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} closed schema`);
    assert.ok(!tool.description.includes('services:write'), `${name} must not name a write scope`);
    const { client, calls } = fakeClient(() => ({ data: name }));
    const result = await tool.handler(client, args);
    assert.deepEqual(calls, [{ method: 'GET', path }]);
    assert.deepEqual(JSON.parse(textOf(result)), { data: name });
  });
}

test('object storage read: get_object_storage says it returns null when the service is not enabled', async () => {
  assert.match(getObjectStorage.description, /null/);
  const { client } = fakeClient(() => null);
  assert.equal(textOf(await getObjectStorage.handler(client, {})), 'null');
});

test('object storage read: usage tools advertise days as an integer 1-90', () => {
  for (const t of [getObjectStorageUsage, getBucketUsage]) {
    assert.deepEqual(
      { ...(t.inputSchema.properties.days as Record<string, unknown>), description: undefined },
      { type: 'integer', minimum: 1, maximum: 90, description: undefined },
      t.name,
    );
  }
});

test('object storage read: bucket id reads name list_buckets and reject traversal with no request', async () => {
  for (const t of [getBucket, getBucketUsage]) {
    assert.deepEqual(t.inputSchema.required, ['id']);
    assert.match((t.inputSchema.properties.id as { description: string }).description, /list_buckets/);
    for (const bad of ['..', '.', '']) {
      const { client, calls } = fakeClient();
      const result = await t.handler(client, { id: bad });
      assert.equal(result.isError, true, `${t.name} must refuse id=${JSON.stringify(bad)}`);
      assert.deepEqual(calls, [], `${t.name} must make no request for id=${JSON.stringify(bad)}`);
    }
  }
});

test('object storage read: an APIError becomes an error result', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'Object storage is not enabled.' });
  });
  const result = await getObjectStorageUsage.handler(client, {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Object storage is not enabled/);
});

// --- writes: shared expectations ----------------------------------------------

const WRITES: Array<[ToolDefinition, string, string]> = [
  [enableObjectStorage, 'enable_object_storage', 'spends'],
  [disableObjectStorage, 'disable_object_storage', 'destructive'],
  [createBucket, 'create_bucket', 'spends'],
  [updateBucket, 'update_bucket', 'sensitive'],
  [deleteBucket, 'delete_bucket', 'destructive'],
  [createObjectStorageKey, 'create_object_storage_key', 'sensitive'],
  [deleteObjectStorageKey, 'delete_object_storage_key', 'destructive'],
];

test('object storage writes: name, closed schema, one services:write, gated, kind annotations', () => {
  for (const [tool, name, kind] of WRITES) {
    assert.equal(tool.name, name);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} closed schema`);
    assert.equal(tool.description.split('services:write').length - 1, 1, `${name} names services:write once`);
    assert.ok(tool.inputSchema.required?.includes('confirm'), `${name} is gated`);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, kind === 'destructive' || kind === 'disruptive', name);
  }
});

// --- account ------------------------------------------------------------------

test('enable_object_storage: POST /v1/object-storage with no body, only with confirm', async () => {
  const { client, calls } = fakeClient();
  assert.equal((await enableObjectStorage.handler(client, {})).isError, true);
  assert.deepEqual(calls, []);
  await enableObjectStorage.handler(client, { confirm: true });
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/object-storage' }]);
  assert.match(enableObjectStorage.description, /create_bucket/);
});

test('disable_object_storage: DELETE /v1/object-storage', async () => {
  const { client, calls } = fakeClient();
  await disableObjectStorage.handler(client, { confirm: true });
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/object-storage' }]);
});

// --- buckets ------------------------------------------------------------------

test('create_bucket: POST body carries name + region, optional versioning/handle only when given', async () => {
  const { client, calls } = fakeClient();
  await createBucket.handler(client, { name: 'assets', region: 'eu-central-1', confirm: true });
  await createBucket.handler(client, {
    name: 'assets', region: 'eu-central-1', versioning: true, handle: 'acme', confirm: true,
  });
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/object-storage/buckets', body: { name: 'assets', region: 'eu-central-1' } },
    {
      method: 'POST', path: '/v1/object-storage/buckets',
      body: { name: 'assets', region: 'eu-central-1', versioning: true, handle: 'acme' },
    },
  ]);
  assert.match((createBucket.inputSchema.properties.region as { description: string }).description, /list_object_storage_regions/);
});

test('create_bucket: enforces the route bounds (name 3-40, handle 3-16) before any request', async () => {
  for (const bad of [
    { name: 'ab', region: 'r' },
    { name: 'x'.repeat(41), region: 'r' },
    { name: 'abc', region: '' },
    { name: 'abc', region: 'r', handle: 'ab' },
    { name: 'abc', region: 'r', handle: 'x'.repeat(17) },
    { name: 'abc', region: 'r', extra: 1 },
  ]) {
    const { client, calls } = fakeClient();
    const result = await createBucket.handler(client, { ...bad, confirm: true });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.deepEqual(calls, []);
  }
  const props = createBucket.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.name.minLength, 3);
  assert.equal(props.name.maxLength, 40);
  assert.equal(props.handle.minLength, 3);
  assert.equal(props.handle.maxLength, 16);
});

test('update_bucket: PATCH sends only the fields given; needs at least one', async () => {
  const { client, calls } = fakeClient();
  await updateBucket.handler(client, { id: BUCKET, public: true, confirm: true });
  await updateBucket.handler(client, { id: BUCKET, versioning: false, confirm: true });
  assert.deepEqual(calls, [
    { method: 'PATCH', path: `/v1/object-storage/buckets/${BUCKET}`, body: { public: true } },
    { method: 'PATCH', path: `/v1/object-storage/buckets/${BUCKET}`, body: { versioning: false } },
  ]);
  const empty = fakeClient();
  const result = await updateBucket.handler(empty.client, { id: BUCKET, confirm: true });
  assert.equal(result.isError, true);
  assert.deepEqual(empty.calls, []);
  assert.match(updateBucket.description, /public/);
});

test('delete_bucket: DELETE with confirm=<bucket name> and purge only when true', async () => {
  const { client, calls } = fakeClient();
  await deleteBucket.handler(client, { id: BUCKET, bucket_name: 'acme-assets', confirm: true });
  await deleteBucket.handler(client, { id: BUCKET, bucket_name: 'acme-assets', purge: true, confirm: true });
  await deleteBucket.handler(client, { id: BUCKET, bucket_name: 'a b&c', purge: false, confirm: true });
  assert.deepEqual(calls, [
    { method: 'DELETE', path: `/v1/object-storage/buckets/${BUCKET}?confirm=acme-assets` },
    { method: 'DELETE', path: `/v1/object-storage/buckets/${BUCKET}?confirm=acme-assets&purge=true` },
    { method: 'DELETE', path: `/v1/object-storage/buckets/${BUCKET}?confirm=a+b%26c` },
  ]);
  assert.match((deleteBucket.inputSchema.properties.bucket_name as { description: string }).description, /list_buckets/);
  assert.ok(deleteBucket.inputSchema.required?.includes('bucket_name'));
});

// --- keys -----------------------------------------------------------------------

test('create_object_storage_key: POST body nests buckets + access under scope', async () => {
  const { client, calls } = fakeClient();
  await createObjectStorageKey.handler(client, { name: 'ci', buckets: '*', access: 'read', confirm: true });
  await createObjectStorageKey.handler(client, { name: 'ci', buckets: [BUCKET], access: 'readwrite', confirm: true });
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/object-storage/keys', body: { name: 'ci', scope: { buckets: '*', access: 'read' } } },
    {
      method: 'POST', path: '/v1/object-storage/keys',
      body: { name: 'ci', scope: { buckets: [BUCKET], access: 'readwrite' } },
    },
  ]);
  assert.match((createObjectStorageKey.inputSchema.properties.buckets as { description: string }).description, /list_buckets/);
});

test('create_object_storage_key: rejects a bad scope before any request', async () => {
  for (const bad of [
    { name: 'ci', buckets: [], access: 'read' },
    { name: 'ci', buckets: 'all', access: 'read' },
    { name: 'ci', buckets: '*', access: 'write' },
    { name: '', buckets: '*', access: 'read' },
    { name: 'x'.repeat(81), buckets: '*', access: 'read' },
  ]) {
    const { client, calls } = fakeClient();
    assert.equal((await createObjectStorageKey.handler(client, { ...bad, confirm: true })).isError, true, JSON.stringify(bad));
    assert.deepEqual(calls, []);
  }
});

test('create_object_storage_key: marked as returning a one-time secret', () => {
  assert.match(createObjectStorageKey.description, /SECURITY: the result contains [^]*secret[^]*, a live credential/);
  assert.match(createObjectStorageKey.description, /only (this )?once/);
});

test('delete_object_storage_key: DELETE /v1/object-storage/keys/{id}; id from list_object_storage_keys', async () => {
  const { client, calls } = fakeClient();
  await deleteObjectStorageKey.handler(client, { id: KEY, confirm: true });
  assert.deepEqual(calls, [{ method: 'DELETE', path: `/v1/object-storage/keys/${KEY}` }]);
  assert.match((deleteObjectStorageKey.inputSchema.properties.id as { description: string }).description, /list_object_storage_keys/);
});

test('object storage writes: every id segment rejects traversal with no request', async () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [updateBucket, { public: false }],
    [deleteBucket, { bucket_name: 'x' }],
    [deleteObjectStorageKey, {}],
  ];
  for (const [tool, rest] of cases) {
    for (const bad of ['..', '.']) {
      const { client, calls } = fakeClient();
      const result = await tool.handler(client, { ...rest, id: bad, confirm: true });
      assert.equal(result.isError, true, `${tool.name} id=${bad}`);
      assert.deepEqual(calls, [], `${tool.name} id=${bad}`);
    }
  }
});
