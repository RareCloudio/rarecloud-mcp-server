// Unit tests for the Parity Phase B billing-safe WRITE tools (Task 8):
// set/delete a month-to-date spend alert and redeem a credit voucher. A fake
// client records method+path+body (no network); we assert closed schemas,
// exact body shapes, the confirm/destructive gate on delete, and both-layer
// constraint mirrors.
//
// SECURITY policy under test: an agent PAT never moves raw money. These three
// are the ONLY billing writes the policy allows — a threshold alert (no
// money), its removal, and voucher redemption (grants credit, no money OUT).
// credit top-up, invoice pay, and payment-methods are EXCLUDED (proven absent
// by the registry exclusion guard in index.test.ts). All scope billing:write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setBillingAlert, deleteBillingAlert, redeemVoucher } from './billing-write.js';
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

test('task8 billing: each tool names scope billing:write and no foreign scope', () => {
  for (const tool of [setBillingAlert, deleteBillingAlert, redeemVoucher]) {
    assert.match(tool.description, /billing:write/, `${tool.name} description must name the scope`);
    assert.doesNotMatch(tool.description, /account:write|tickets:write/, `${tool.name} must not name a foreign scope`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must have a closed schema`);
  }
});

// --- set_billing_alert (PUT /v1/billing/alert, billing:write, no gate) -----

test('set_billing_alert: name + closed schema (no confirm — plain write)', () => {
  assert.equal(setBillingAlert.name, 'set_billing_alert');
  assert.deepEqual(setBillingAlert.inputSchema.required, ['thresholdCents']);
  assert.ok(!('confirm' in setBillingAlert.inputSchema.properties));
  assert.equal(setBillingAlert.annotations, undefined);
});

test('set_billing_alert: PUTs {thresholdCents} to /v1/billing/alert (enabled omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setBillingAlert.handler(client, { thresholdCents: 5000 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PUT', path: '/v1/billing/alert', body: { thresholdCents: 5000 } }]);
});

test('set_billing_alert: forwards enabled when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setBillingAlert.handler(client, { thresholdCents: 5000, enabled: false });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PUT', path: '/v1/billing/alert', body: { thresholdCents: 5000, enabled: false } }]);
});

test('set_billing_alert: rejects thresholdCents below 100 (€1) before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setBillingAlert.handler(client, { thresholdCents: 99 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_billing_alert:/);
  assert.deepEqual(calls, []);
});

test('set_billing_alert: rejects a non-integer thresholdCents before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setBillingAlert.handler(client, { thresholdCents: 100.5 });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('set_billing_alert: schema mirrors thresholdCents minimum 100', () => {
  const props = setBillingAlert.inputSchema.properties as Record<string, { minimum?: number }>;
  assert.equal(props.thresholdCents.minimum, 100);
});

// --- delete_billing_alert (DELETE /v1/billing/alert, confirm+destr) --------
// The singleton alert — no path segment. confirm+destr is kept for rule
// uniformity even though the blast radius is low and it's re-creatable via
// set_billing_alert (the description says so).

test('delete_billing_alert: closed empty schema, requires only confirm, destructiveHint set', () => {
  assert.deepEqual(delete_billing_alert_props(), ['confirm']);
  assert.deepEqual(deleteBillingAlert.inputSchema.required, ['confirm']);
  assert.equal(deleteBillingAlert.annotations?.destructiveHint, true);
});
function delete_billing_alert_props(): string[] {
  return Object.keys(deleteBillingAlert.inputSchema.properties);
}

test('delete_billing_alert: DELETEs /v1/billing/alert with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteBillingAlert.handler(client, { confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/billing/alert' }]);
});

test('delete_billing_alert: refuses with NO request when confirm is absent', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteBillingAlert.handler(client, {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

test('delete_billing_alert: rejects any supplied domain property (strict schema)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteBillingAlert.handler(client, { id: 'x', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for delete_billing_alert:/);
  assert.deepEqual(calls, []);
});

// --- redeem_voucher (POST /v1/billing/vouchers/redeem, billing:write) ------
// openapi DOC-GAP: the POST has NO requestBody documented; the route reads
// input.code (RedeemInput = { code: string.min(1).max(64) }, v1-billing.ts) —
// the route is authoritative, so the body is {code}.

test('redeem_voucher: POSTs {code} to /v1/billing/vouchers/redeem', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await redeemVoucher.handler(client, { code: 'WELCOME10' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/billing/vouchers/redeem', body: { code: 'WELCOME10' } }]);
});

test('redeem_voucher: rejects an empty code / one over 64 chars before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const code of ['', 'x'.repeat(65)]) {
    const result = await redeemVoucher.handler(client, { code });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error: Invalid input for redeem_voucher:/);
  }
  assert.deepEqual(calls, []);
});

test('redeem_voucher: never echoes the raw voucher code in a validation error', async () => {
  const { client, calls } = fakeWriteClient();
  const secretCode = 'SUPER-SECRET-VOUCHER-VALUE-' + 'x'.repeat(64);
  const result = await redeemVoucher.handler(client, { code: secretCode });
  assert.equal(result.isError, true);
  assert.doesNotMatch(textOf(result), /SUPER-SECRET-VOUCHER-VALUE/, 'the voucher code must not appear in the error text');
  assert.deepEqual(calls, []);
});

test('redeem_voucher: schema mirrors code (1-64) bounds and closed schema', () => {
  const props = redeemVoucher.inputSchema.properties as Record<string, { minLength?: number; maxLength?: number }>;
  assert.equal(props.code.minLength, 1);
  assert.equal(props.code.maxLength, 64);
  assert.deepEqual(redeemVoucher.inputSchema.required, ['code']);
});

// --- APIError mapping (representative) --------------------------------------

test('task8 billing: APIError maps to a [CODE] message (representative)', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'billing:write scope required' });
  });
  const result = await redeemVoucher.handler(client, { code: 'WELCOME10' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] billing:write scope required');
});
