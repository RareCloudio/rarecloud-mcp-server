// Unit tests for the services-core read tools added in Parity Phase A / Task 3
// (mounted ISO status, SSH key library, auto-renew flag). Fake client records
// the constructed path; no network. (get_vpanel_status was dropped in final
// review — its route is browser-only, so a bearer token can never succeed.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getServiceIso,
  listServiceSshKeyLibrary,
  getServiceAutorenew,
} from './services.js';
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

// Each tool takes exactly one required service_id and hits a fixed sub-path.
// [tool, name, suffix] — the path is /v1/services/{service_id}{suffix}.
const idScoped: Array<[ToolDefinition, string, string]> = [
  [getServiceIso, 'get_service_iso', '/iso'],
  [listServiceSshKeyLibrary, 'list_service_ssh_key_library', '/ssh-keys/library'],
  [getServiceAutorenew, 'get_service_autorenew', '/autorenew'],
];

for (const [tool, name, suffix] of idScoped) {
  test(`services: ${name} — encodes service_id into ${suffix}`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    const { client, calls } = fakeClient(() => ({}));
    await tool.handler(client, { service_id: 'srv 1/2' });
    assert.deepEqual(calls, [`/v1/services/srv%201%2F2${suffix}`]);
  });

  test(`services: ${name} — requires service_id (closed schema, only service_id)`, () => {
    assert.deepEqual(tool.inputSchema.required, ['service_id']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['service_id']);
  });

  test(`services: ${name} — APIError maps to errorResult`, async () => {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'NOT_FOUND', message: 'no such service' });
    });
    const result = await tool.handler(client, { service_id: 'srv-1' });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: [NOT_FOUND] no such service');
  });
}
