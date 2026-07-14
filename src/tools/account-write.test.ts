// Unit tests for the Parity Phase B account-safe WRITE tools (Task 8):
// update-profile, account SSH keys (add/delete), resend-email-verification,
// manage-contact, create-affiliate-link. A fake client records method+path+body
// (no network); we assert closed schemas, path + segment encoding, exact body
// shapes (incl. omit-undefined optionals), the confirm/destructive gate on the
// one destructive tool, the traversal guard on its dynamic `id` segment, and
// both-layer (zod + JSON inputSchema) constraint mirrors.
//
// SECURITY policy under test: an agent PAT manages INFRASTRUCTURE, never
// identity/credentials/raw money. These six are the ONLY account-adjacent
// writes the policy allows — every one is scope account:write, none touches a
// password / 2FA / sub-user invite / affiliate activate-or-withdraw. The
// registry-level exclusion guard (index.test.ts) proves the forbidden ones
// don't exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateAccount,
  addAccountSshKey,
  deleteAccountSshKey,
  resendEmailVerification,
  manageAccountContact,
  createAffiliateLink,
} from './account-write.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

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
// Registry-shape invariants for all six (name, closed schema, scope named).
// ---------------------------------------------------------------------------
const ALL = {
  update_account: updateAccount,
  add_account_ssh_key: addAccountSshKey,
  delete_account_ssh_key: deleteAccountSshKey,
  resend_email_verification: resendEmailVerification,
  manage_account_contact: manageAccountContact,
  create_affiliate_link: createAffiliateLink,
};

test('task8 account: each tool has its name, closed schema, and names scope account:write', () => {
  for (const [name, tool] of Object.entries(ALL)) {
    assert.equal(tool.name, name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.match(tool.description, /account:write/, `${name} description must name the scope`);
    // No account-safe tool leaks another domain's write scope.
    assert.doesNotMatch(tool.description, /billing:write|tickets:write/, `${name} must not name a foreign scope`);
  }
});

test('task8 account: only delete_account_ssh_key is gated + destructive; the rest are plain writes', () => {
  for (const [name, tool] of Object.entries(ALL)) {
    const gated = name === 'delete_account_ssh_key';
    assert.equal('confirm' in tool.inputSchema.properties, gated, `${name}: confirm-in-schema must match gated=${gated}`);
    assert.equal(tool.annotations?.destructiveHint ?? false, gated, `${name}: destructiveHint must match gated=${gated}`);
  }
});

// --- update_account (PATCH /v1/account, account:write, no gate) -------------
// DEVIATION FROM BRIEF: the brief's field list includes `preferredCurrency`,
// but the route's AccountPatchInput allow-list (v1-account.ts) does NOT accept
// it (unknown keys are stripped server-side). openapi's PATCH body merely
// $refs the full `Account` RESPONSE schema (which carries preferredCurrency as
// a read field) — reality (route) wins, so preferredCurrency is dropped and is
// rejected by the strict schema.

test('update_account: PATCHes only the provided fields to /v1/account (optionals omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateAccount.handler(client, { firstName: 'Ada', lastName: 'Lovelace', city: 'Bucuresti' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PATCH', path: '/v1/account', body: { firstName: 'Ada', lastName: 'Lovelace', city: 'Bucuresti' } },
  ]);
});

test('update_account: forwards every accepted field when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateAccount.handler(client, {
    firstName: 'Ada',
    lastName: 'Lovelace',
    companyName: 'Analytical Engines',
    address: '1 Countess St',
    city: 'London',
    postcode: 'W1',
    country: 'GB',
    phone: '+44 20 7946 0000',
    taxId: 'GB123',
    language: 'en',
    email: 'ada@example.com',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'PATCH',
      path: '/v1/account',
      body: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        companyName: 'Analytical Engines',
        address: '1 Countess St',
        city: 'London',
        postcode: 'W1',
        country: 'GB',
        phone: '+44 20 7946 0000',
        taxId: 'GB123',
        language: 'en',
        email: 'ada@example.com',
      },
    },
  ]);
});

test('update_account: rejects preferredCurrency (deviation: brief listed it; route does not accept it)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateAccount.handler(client, { preferredCurrency: 'USD' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for update_account:/);
  assert.deepEqual(calls, []);
});

test('update_account: rejects a malformed email before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateAccount.handler(client, { email: 'not-an-email' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for update_account:/);
  assert.deepEqual(calls, []);
});

test('update_account: rejects a country code that is not exactly 2 letters', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateAccount.handler(client, { country: 'ROU' });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('update_account: rejects an unknown language before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await updateAccount.handler(client, { language: 'fr' });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('update_account: schema mirrors field maxLengths, country length, email format, language enum', () => {
  const props = updateAccount.inputSchema.properties as Record<
    string,
    { maxLength?: number; minLength?: number; format?: string; enum?: string[] }
  >;
  assert.equal(props.firstName.maxLength, 64);
  assert.equal(props.lastName.maxLength, 64);
  assert.equal(props.companyName.maxLength, 128);
  assert.equal(props.address.maxLength, 128);
  assert.equal(props.city.maxLength, 64);
  assert.equal(props.postcode.maxLength, 16);
  assert.equal(props.phone.maxLength, 32);
  assert.equal(props.taxId.maxLength, 32);
  assert.equal(props.country.minLength, 2);
  assert.equal(props.country.maxLength, 2);
  assert.equal(props.email.format, 'email');
  assert.equal(props.email.maxLength, 254);
  assert.deepEqual(props.language.enum, ['en', 'ro']);
  // preferredCurrency is NOT advertised (dropped per the route allow-list).
  assert.ok(!('preferredCurrency' in props), 'preferredCurrency must not be advertised');
});

// --- add_account_ssh_key (POST /v1/account/ssh-keys, account:write) --------

test('add_account_ssh_key: POSTs {name, publicKey} to /v1/account/ssh-keys', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addAccountSshKey.handler(client, { name: 'laptop', publicKey: 'ssh-ed25519 AAAA...' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/account/ssh-keys', body: { name: 'laptop', publicKey: 'ssh-ed25519 AAAA...' } },
  ]);
});

test('add_account_ssh_key: rejects an empty name / publicKey before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const args of [{ name: '', publicKey: 'ssh-ed25519 AAAA' }, { name: 'laptop', publicKey: '' }]) {
    const result = await addAccountSshKey.handler(client, args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error: Invalid input for add_account_ssh_key:/);
  }
  assert.deepEqual(calls, []);
});

test('add_account_ssh_key: schema mirrors name (1-200) and publicKey (1-4096) bounds', () => {
  const props = addAccountSshKey.inputSchema.properties as Record<string, { minLength?: number; maxLength?: number }>;
  assert.equal(props.name.minLength, 1);
  assert.equal(props.name.maxLength, 200);
  assert.equal(props.publicKey.minLength, 1);
  assert.equal(props.publicKey.maxLength, 4096);
});

// --- delete_account_ssh_key (DELETE /v1/account/ssh-keys/{id}, confirm+destr) --

test('delete_account_ssh_key: name + closed schema, requires id + confirm, destructiveHint set', () => {
  assert.equal(deleteAccountSshKey.name, 'delete_account_ssh_key');
  assert.deepEqual(deleteAccountSshKey.inputSchema.required, ['id', 'confirm']);
  assert.equal(deleteAccountSshKey.annotations?.destructiveHint, true);
});

test('delete_account_ssh_key: DELETEs /v1/account/ssh-keys/{id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteAccountSshKey.handler(client, { id: 'key 1/2', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/account/ssh-keys/key%201%2F2' }]);
});

test('delete_account_ssh_key: refuses with NO request when confirm is absent', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteAccountSshKey.handler(client, { id: 'key-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

test('delete_account_ssh_key: a ".." id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteAccountSshKey.handler(client, { id: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid id value');
  assert.deepEqual(calls, []);
});

// --- resend_email_verification (POST /v1/account/verify-email/resend) ------

test('resend_email_verification: POSTs to the endpoint with NO body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await resendEmailVerification.handler(client, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/account/verify-email/resend', body: undefined }]);
});

test('resend_email_verification: rejects any supplied property (strict empty schema)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await resendEmailVerification.handler(client, { email: 'x@example.com' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for resend_email_verification:/);
  assert.deepEqual(calls, []);
});

// --- manage_account_contact (POST /v1/account/contacts, account:write) -----

test('manage_account_contact: name + closed schema, action enum required', () => {
  assert.deepEqual(manageAccountContact.inputSchema.required, ['action']);
  const props = manageAccountContact.inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(props.action.enum, ['add', 'update', 'delete']);
});

test('manage_account_contact: POSTs {action} + only the provided fields (omit undefined)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageAccountContact.handler(client, {
    action: 'add',
    firstname: 'Ada',
    lastname: 'Lovelace',
    email: 'ada@example.com',
    invoiceemails: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/account/contacts',
      body: { action: 'add', firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com', invoiceemails: true },
    },
  ]);
});

test('manage_account_contact: forwards id for update/delete', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageAccountContact.handler(client, { action: 'delete', id: 42 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/account/contacts', body: { action: 'delete', id: 42 } }]);
});

test('manage_account_contact: rejects an unknown action before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageAccountContact.handler(client, { action: 'purge' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for manage_account_contact:/);
  assert.deepEqual(calls, []);
});

test('manage_account_contact: rejects a non-positive / non-integer id', async () => {
  const { client, calls } = fakeWriteClient();
  for (const id of [0, -1, 1.5]) {
    const result = await manageAccountContact.handler(client, { action: 'delete', id });
    assert.equal(result.isError, true, `id=${id} must be rejected`);
  }
  assert.deepEqual(calls, []);
});

test('manage_account_contact: rejects a malformed email before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageAccountContact.handler(client, { action: 'add', email: 'not-an-email' });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

// --- create_affiliate_link (POST /v1/account/affiliate/link, account:write) --

test('create_affiliate_link: POSTs {destination} to /v1/account/affiliate/link', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createAffiliateLink.handler(client, { destination: 'https://example.com/landing' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/account/affiliate/link', body: { destination: 'https://example.com/landing' } },
  ]);
});

test('create_affiliate_link: rejects an empty destination / one over 2048 chars', async () => {
  const { client, calls } = fakeWriteClient();
  for (const destination of ['', 'https://example.com/' + 'x'.repeat(2048)]) {
    const result = await createAffiliateLink.handler(client, { destination });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error: Invalid input for create_affiliate_link:/);
  }
  assert.deepEqual(calls, []);
});

test('create_affiliate_link: schema mirrors destination (1-2048) bounds', () => {
  const props = createAffiliateLink.inputSchema.properties as Record<string, { minLength?: number; maxLength?: number }>;
  assert.equal(props.destination.minLength, 1);
  assert.equal(props.destination.maxLength, 2048);
});

// --- APIError mapping (representative) --------------------------------------

test('task8 account: APIError maps to a [CODE] message (representative)', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'account:write scope required' });
  });
  const result = await updateAccount.handler(client, { firstName: 'Ada' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] account:write scope required');
});
