// Unit tests for the tokens read tool added in Parity Phase A / Task 2
// (list API tokens). Fake client records the constructed path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTokens } from './tokens.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

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

test('tokens: list_tokens — name, GETs /v1/tokens, non-empty description', async () => {
  assert.equal(listTokens.name, 'list_tokens');
  assert.ok(listTokens.description.trim().length > 0);
  const { client, calls } = fakeClient(() => [{ id: 'tok-123', name: 'ci' }]);
  const result = await listTokens.handler(client, {});
  assert.deepEqual(calls, ['/v1/tokens']);
  assert.equal(result.isError, undefined);
});

test('tokens: list_tokens — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'UNAUTHORIZED', message: 'cookie auth required' });
  });
  const result = await listTokens.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [UNAUTHORIZED] cookie auth required');
});
