// Unit tests for the account read tools added in Parity Phase A / Task 2.
// A fake client records the path it was called with (or throws), so we assert
// on path construction, query encoding, and APIError -> errorResult mapping —
// no network, no real client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listAccountClients,
  getAffiliate,
  getTwoFactorStatus,
  listAccountSshKeys,
  getAccountActivity,
  listAccountEmails,
  listAccountContacts,
} from './account.js';
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

// --- fixed (no-input) reads -----------------------------------------------

const fixed: Array<[ToolDefinition, string, string]> = [
  [listAccountClients, 'list_account_clients', '/v1/account/clients'],
  [getAffiliate, 'get_affiliate', '/v1/account/affiliate'],
  [getTwoFactorStatus, 'get_two_factor_status', '/v1/account/two-factor'],
  [listAccountSshKeys, 'list_account_ssh_keys', '/v1/account/ssh-keys'],
  [listAccountContacts, 'list_account_contacts', '/v1/account/contacts'],
];

for (const [tool, name, path] of fixed) {
  test(`account: ${name} — name, GETs ${path}, non-empty description`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    const { client, calls } = fakeClient(() => ({ ok: true }));
    const result = await tool.handler(client, {});
    assert.deepEqual(calls, [path]);
    assert.equal(result.isError, undefined);
  });
}

test('account: list_account_ssh_keys description disambiguates from per-server list_ssh_keys', () => {
  assert.match(listAccountSshKeys.description, /account-wide/i);
});

test('account: fixed reads map APIError to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'account:read required' });
  });
  const result = await getAffiliate.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] account:read required');
});

// --- get_account_activity (limit + before pagination) ---------------------

test('account: get_account_activity — no args hits the bare path', async () => {
  const { client, calls } = fakeClient(() => []);
  await getAccountActivity.handler(client, {});
  assert.deepEqual(calls, ['/v1/account/activity']);
});

test('account: get_account_activity — limit + before are encoded into the query', async () => {
  const { client, calls } = fakeClient(() => []);
  await getAccountActivity.handler(client, { limit: 50, before: 'a/b c&d' });
  assert.deepEqual(calls, ['/v1/account/activity?limit=50&before=a%2Fb+c%26d']);
});

test('account: get_account_activity — schema exposes only limit + before, closed', () => {
  assert.deepEqual(Object.keys(getAccountActivity.inputSchema.properties).sort(), ['before', 'limit']);
  assert.equal(getAccountActivity.inputSchema.additionalProperties, false);
});

test('account: get_account_activity — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'account:read required' });
  });
  const result = await getAccountActivity.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] account:read required');
});

// --- list_account_emails (offset + optional id) ---------------------------

test('account: list_account_emails — no args hits the bare path', async () => {
  const { client, calls } = fakeClient(() => []);
  await listAccountEmails.handler(client, {});
  assert.deepEqual(calls, ['/v1/account/emails']);
});

test('account: list_account_emails — offset + id are encoded into the query', async () => {
  const { client, calls } = fakeClient(() => ({}));
  await listAccountEmails.handler(client, { offset: 20, id: 'em 1/2' });
  assert.deepEqual(calls, ['/v1/account/emails?offset=20&id=em+1%2F2']);
});

test('account: list_account_emails — id alone fetches one message', async () => {
  const { client, calls } = fakeClient(() => ({}));
  await listAccountEmails.handler(client, { id: 'em-9' });
  assert.deepEqual(calls, ['/v1/account/emails?id=em-9']);
});

test('account: list_account_emails — schema exposes only offset + id', () => {
  assert.deepEqual(Object.keys(listAccountEmails.inputSchema.properties).sort(), ['id', 'offset']);
  assert.equal(listAccountEmails.inputSchema.additionalProperties, false);
});
