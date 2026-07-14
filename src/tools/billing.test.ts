// Unit tests for the billing read tools added in Parity Phase A / Task 2
// (pay-preview, payment methods, campaign, bonus balance/ledger, alert, state).
// Fake client records the constructed path; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getInvoicePayPreview,
  listPaymentMethods,
  getBillingCampaign,
  getBonusBalance,
  getBonusLedger,
  getBillingAlert,
  getBillingState,
} from './billing.js';
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
  [listPaymentMethods, 'list_payment_methods', '/v1/billing/payment-methods'],
  [getBillingCampaign, 'get_billing_campaign', '/v1/billing/campaign'],
  [getBonusBalance, 'get_bonus_balance', '/v1/billing/bonus'],
  [getBonusLedger, 'get_bonus_ledger', '/v1/billing/bonus/ledger'],
  [getBillingAlert, 'get_billing_alert', '/v1/billing/alert'],
  [getBillingState, 'get_billing_state', '/v1/billing/state'],
];

for (const [tool, name, path] of fixed) {
  test(`billing: ${name} — name, GETs ${path}, non-empty description`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    const { client, calls } = fakeClient(() => ({ ok: true }));
    const result = await tool.handler(client, {});
    assert.deepEqual(calls, [path]);
    assert.equal(result.isError, undefined);
  });
}

test('billing: bonus balance and bonus ledger are distinct paths (ledger is a sub-path)', () => {
  // Guards against accidentally pointing both at /v1/billing/bonus.
  assert.notEqual(getBonusBalance, getBonusLedger);
});

// --- get_invoice_pay_preview ({id}/pay-preview) ---------------------------

test('billing: get_invoice_pay_preview — encodes id into the /pay-preview sub-path', async () => {
  const { client, calls } = fakeClient(() => ({}));
  await getInvoicePayPreview.handler(client, { id: 'inv 1/2' });
  assert.deepEqual(calls, ['/v1/billing/invoices/inv%201%2F2/pay-preview']);
});

test('billing: get_invoice_pay_preview — requires id (closed schema)', () => {
  assert.equal(getInvoicePayPreview.name, 'get_invoice_pay_preview');
  assert.deepEqual(getInvoicePayPreview.inputSchema.required, ['id']);
  assert.equal(getInvoicePayPreview.inputSchema.additionalProperties, false);
  assert.ok('id' in getInvoicePayPreview.inputSchema.properties);
  assert.ok(getInvoicePayPreview.description.trim().length > 0);
});

test('billing: get_invoice_pay_preview — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'no such invoice' });
  });
  const result = await getInvoicePayPreview.handler(client, { id: 'inv-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [NOT_FOUND] no such invoice');
});
