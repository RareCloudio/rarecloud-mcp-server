// Unit tests for the shared tool factories. We inject a fake client whose
// `get` records the path it was called with (and optionally throws), so we
// can assert on path construction, id/query encoding, and the uniform
// APIError -> errorResult mapping without any network or real client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readList, readOne, readTool } from './factories.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

// A minimal stand-in for RareCloudClient exposing only `get`, which is all
// the read factories use. `onGet` receives the path and returns the data
// (or throws to exercise the error path).
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

// Pull the single text block out of a ToolCallResult for assertions.
function textOf(result: ToolCallResult): string {
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

// --- readList -------------------------------------------------------------

test('readList: shape (name, description, empty closed schema)', () => {
  const tool = readList('list_things', '/v1/things', 'List the things.');
  assert.equal(tool.name, 'list_things');
  assert.equal(tool.description, 'List the things.');
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
});

test('readList: handler GETs the fixed path and JSON-encodes the data', async () => {
  const { client, calls } = fakeClient(() => [{ id: 'svc-123' }]);
  const tool = readList('list_things', '/v1/things', 'List the things.');
  const result = await tool.handler(client, {});
  assert.deepEqual(calls, ['/v1/things']);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: 'svc-123' }]);
});

test('readList: APIError maps to errorResult with the API message', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'read scope required' });
  });
  const tool = readList('list_things', '/v1/things', 'List the things.');
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] read scope required');
});

// --- readOne --------------------------------------------------------------

test('readOne: default idKey "id" — required, closed schema', () => {
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  assert.equal(tool.name, 'get_thing');
  assert.deepEqual(tool.inputSchema.required, ['id']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok('id' in tool.inputSchema.properties);
});

test('readOne: custom idKey drives both the property and the required list', () => {
  const tool = readOne('get_domain', '/v1/domains', 'Get one domain.', 'domain_id');
  assert.deepEqual(tool.inputSchema.required, ['domain_id']);
  assert.ok('domain_id' in tool.inputSchema.properties);
});

test('readOne: URL-encodes the id into the path', async () => {
  const { client, calls } = fakeClient(() => ({ id: 'a b/c' }));
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  await tool.handler(client, { id: 'a b/c' });
  assert.deepEqual(calls, ['/v1/things/a%20b%2Fc']);
});

test('readOne: missing id becomes an empty encoded segment (no crash)', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  await tool.handler(client, {});
  assert.deepEqual(calls, ['/v1/things/']);
});

test('readOne: APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'no such thing' });
  });
  const tool = readOne('get_thing', '/v1/things', 'Get one thing.');
  const result = await tool.handler(client, { id: 'svc-123' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [NOT_FOUND] no such thing');
});

// --- readTool -------------------------------------------------------------

test('readTool: passes through name/description/inputSchema', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false };
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: schema,
    buildPath: () => '/v1/things',
  });
  assert.equal(tool.name, 'search_things');
  assert.equal(tool.description, 'Search the things.');
  assert.deepEqual(tool.inputSchema, schema);
});

test('readTool: handler GETs whatever buildPath returns (incl. encoded query)', async () => {
  const { client, calls } = fakeClient(() => [{ id: 'svc-123' }]);
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    buildPath: (args) => `/v1/things?q=${encodeURIComponent(String(args.q))}`,
  });
  const result = await tool.handler(client, { q: 'a b&c' });
  assert.deepEqual(calls, ['/v1/things?q=a%20b%26c']);
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: 'svc-123' }]);
});

test('readTool: APIError maps to errorResult with the API message', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'BAD_REQUEST', message: 'q is required' });
  });
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/things',
  });
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [BAD_REQUEST] q is required');
});

test('readTool: a non-APIError still maps to errorResult via its message', async () => {
  const { client } = fakeClient(() => {
    throw new Error('socket hang up');
  });
  const tool = readTool({
    name: 'search_things',
    description: 'Search the things.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    buildPath: () => '/v1/things',
  });
  const result = await tool.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: socket hang up');
});
