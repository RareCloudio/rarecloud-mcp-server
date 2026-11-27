// list_billing_cycle_options + change_billing_cycle, end to end through the real
// client with a stubbed fetch: the request each one makes, the confirm gate
// making no request, expected_amount sent as expectedAmount, the Idempotency-Key
// header and the safe retry, and the API's refusals passed through unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listBillingCycleOptions } from './services.js';
import { changeBillingCycle, LONGER_BILLING_CYCLES } from './services-write.js';
import { IDEMPOTENCY_KEY_PROPERTY } from './factories.js';
import { RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

type Step = { throws: Error } | { status?: number; body: unknown; headers?: Record<string, string> };
type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

function scriptFetch(steps: Step[]) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body as string | undefined,
    });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ('throws' in step) throw step.throws;
    const status = step.status ?? 200;
    const h = new Map(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
      async text() { return JSON.stringify(step.body); },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const client = () => new RareCloudClient({ endpoint: 'https://example.com', token: 't', sleep: async () => {} });
const texts = (r: ToolCallResult) => r.content.map((b) => (b.type === 'text' ? b.text : ''));

async function withFetch(steps: Step[], fn: (calls: Call[]) => Promise<void>): Promise<void> {
  const s = scriptFetch(steps);
  try {
    await fn(s.calls);
  } finally {
    s.restore();
  }
}

const OPTIONS = {
  productName: 'VPS Elite',
  currentCycle: 'monthly',
  currentNextDueDate: '2026-12-15',
  options: [
    { cycle: 'annually', amount: { amount: 59.4, currency: 'EUR' }, newNextDueDate: '2027-12-15' },
    { cycle: 'triennially', amount: { amount: 150, currency: 'EUR' }, newNextDueDate: '2029-12-15' },
  ],
};

const ORDER = {
  cycle: 'annually',
  currentCycle: 'monthly',
  amount: { amount: 59.4, currency: 'EUR' },
  currentNextDueDate: '2026-12-15',
  newNextDueDate: '2027-12-15',
  replacesRenewalInvoiceIds: [],
  invoiceId: '90210',
};

// --- list_billing_cycle_options (read) ---------------------------------------

test('list_billing_cycle_options: a read with a closed schema that requires service_id', () => {
  const t = listBillingCycleOptions;
  assert.equal(t.name, 'list_billing_cycle_options');
  assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['service_id']);
  assert.deepEqual(t.inputSchema.required, ['service_id']);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.match((t.inputSchema.properties.service_id as { description: string }).description, /list_services/);
});

test('list_billing_cycle_options: GETs /v1/services/{id}/billing-cycle (id encoded) and returns the answer', async () => {
  await withFetch([{ body: { ok: true, data: OPTIONS } }], async (calls) => {
    const r = await listBillingCycleOptions.handler(client(), { service_id: '12 34' });
    assert.equal(r.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://example.com/v1/services/12%2034/billing-cycle');
    assert.equal(calls[0].body, undefined);
    assert.deepEqual(JSON.parse(texts(r)[0]), OPTIONS);
  });
});

test('list_billing_cycle_options: a ".." service_id is refused before any request', async () => {
  await withFetch([{ body: { ok: true, data: OPTIONS } }], async (calls) => {
    const r = await listBillingCycleOptions.handler(client(), { service_id: '..' });
    assert.equal(r.isError, true);
    assert.match(texts(r)[0], /Invalid service_id/);
    assert.equal(calls.length, 0);
  });
});

test('list_billing_cycle_options: an API refusal comes back as [CODE] message', async () => {
  const message = 'Billing cycle changes are available for legacy services only.';
  await withFetch([{ status: 400, body: { ok: false, error: { code: 'INVALID_PARAM', message } } }], async () => {
    const r = await listBillingCycleOptions.handler(client(), { service_id: 'vm-1' });
    assert.equal(r.isError, true);
    assert.equal(texts(r)[0], `Error: [INVALID_PARAM] ${message}`);
  });
});

test('list_billing_cycle_options: the description says what it returns, VAT excluded, places nothing, then change_billing_cycle', () => {
  const d = listBillingCycleOptions.description;
  for (const word of ['currentCycle', 'currentNextDueDate', 'newNextDueDate', 'amount']) {
    assert.ok(d.includes(word), `description should name ${word}`);
  }
  assert.match(d, /excluding VAT/);
  assert.match(d, /places nothing/);
  assert.match(d, /change_billing_cycle/);
  assert.match(d, /expected_amount/);
  assert.match(d, /legacy VPS/);
  assert.ok(!d.includes('services:write'), 'a read must not name the write scope');
  assert.ok(!d.includes('Safety:'));
});

// --- change_billing_cycle (spends) -------------------------------------------

test('change_billing_cycle: the cycle enum is exactly the cycles longer than monthly', () => {
  assert.deepEqual([...LONGER_BILLING_CYCLES], ['quarterly', 'semiannually', 'annually', 'biennially', 'triennially']);
  const cycle = changeBillingCycle.inputSchema.properties.cycle as { type: string; enum: string[] };
  assert.equal(cycle.type, 'string');
  assert.deepEqual(cycle.enum, [...LONGER_BILLING_CYCLES]);
});

test('change_billing_cycle: schema, gate and annotations of a spends tool that takes idempotency_key', () => {
  const t = changeBillingCycle;
  assert.equal(t.name, 'change_billing_cycle');
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['confirm', 'cycle', 'expected_amount', 'idempotency_key', 'service_id']);
  assert.deepEqual([...(t.inputSchema.required ?? [])].sort(), ['confirm', 'cycle', 'service_id']);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.deepEqual(t.inputSchema.properties.expected_amount, {
    type: 'number',
    exclusiveMinimum: 0,
    maximum: 1_000_000,
    description: (t.inputSchema.properties.expected_amount as { description: string }).description,
  });
  assert.match((t.inputSchema.properties.expected_amount as { description: string }).description, /list_billing_cycle_options/);
  assert.deepEqual(t.inputSchema.properties.idempotency_key, IDEMPOTENCY_KEY_PROPERTY);
  assert.equal((t.inputSchema.properties.confirm as { type: string }).type, 'boolean');
  assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  assert.match(t.description, /Requires scope services:write\./);
  assert.match(t.description, /Safety: SPENDS MONEY; this /);
});

test('change_billing_cycle: without confirm:true it refuses and makes no request (there is no quote call)', async () => {
  await withFetch([{ body: { ok: true, data: ORDER } }], async (calls) => {
    for (const confirm of [undefined, false, 'true', 1]) {
      const args: Record<string, unknown> = { service_id: '123', cycle: 'annually', expected_amount: 59.4, idempotency_key: 'k1' };
      if (confirm !== undefined) args.confirm = confirm;
      const r = await changeBillingCycle.handler(client(), args);
      assert.equal(r.isError, true, `confirm=${String(confirm)} must refuse`);
      assert.match(texts(r)[0], /^Error: change_billing_cycle was NOT executed because it spends money: it /);
    }
    assert.equal(calls.length, 0);
  });
});

test('change_billing_cycle: POSTs {cycle, confirm:true} to /v1/services/{id}/billing-cycle; no expectedAmount when none was given', async () => {
  await withFetch([{ body: { ok: true, data: ORDER } }], async (calls) => {
    const r = await changeBillingCycle.handler(client(), { service_id: '123', cycle: 'triennially', confirm: true });
    assert.equal(r.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://example.com/v1/services/123/billing-cycle');
    assert.deepEqual(JSON.parse(calls[0].body!), { cycle: 'triennially', confirm: true });
    assert.deepEqual(JSON.parse(texts(r).at(-1)!), ORDER);
  });
});

test('change_billing_cycle: expected_amount is sent as expectedAmount, unchanged', async () => {
  await withFetch([{ body: { ok: true, data: ORDER } }], async (calls) => {
    await changeBillingCycle.handler(client(), { service_id: '123', cycle: 'annually', expected_amount: 59.4, confirm: true });
    const body = JSON.parse(calls[0].body!);
    assert.deepEqual(body, { cycle: 'annually', confirm: true, expectedAmount: 59.4 });
    assert.ok(!('expected_amount' in body));
  });
});

test('change_billing_cycle: bad input is refused before any request', async () => {
  const bad: Array<Record<string, unknown>> = [
    { cycle: 'monthly' },
    { cycle: 'hourly' },
    { cycle: 'yearly' },
    { cycle: 'annually', expected_amount: 0 },
    { cycle: 'annually', expected_amount: -5 },
    { cycle: 'annually', expected_amount: 1_000_001 },
    { cycle: 'annually', expected_amount: '59.40' },
    { cycle: 'annually', expectedAmount: 59.4 },
    { cycle: 'annually', service_id: '' },
    { cycle: 'annually', service_id: '..' },
    {},
  ];
  await withFetch([{ body: { ok: true, data: ORDER } }], async (calls) => {
    for (const extra of bad) {
      const r = await changeBillingCycle.handler(client(), { service_id: '123', ...extra, confirm: true });
      assert.equal(r.isError, true, `must refuse ${JSON.stringify(extra)}`);
    }
    assert.equal(calls.length, 0);
  });
});

test('change_billing_cycle: idempotency_key is sent as the Idempotency-Key header and never in the body', async () => {
  await withFetch([{ body: { ok: true, data: ORDER } }], async (calls) => {
    await changeBillingCycle.handler(client(), { service_id: '123', cycle: 'annually', idempotency_key: 'cycle-123-annually', confirm: true });
    assert.equal(calls[0].headers['Idempotency-Key'], 'cycle-123-annually');
    assert.deepEqual(JSON.parse(calls[0].body!), { cycle: 'annually', confirm: true });
  });
});

test('change_billing_cycle: a dropped first answer is retried once with the same generated key', async () => {
  await withFetch([{ throws: new TypeError('fetch failed') }, { body: { ok: true, data: ORDER } }], async (calls) => {
    const r = await changeBillingCycle.handler(client(), { service_id: '123', cycle: 'annually', confirm: true });
    assert.equal(r.isError, undefined);
    assert.equal(calls.length, 2);
    const key = calls[0].headers['Idempotency-Key'];
    assert.ok(key);
    assert.equal(calls[1].headers['Idempotency-Key'], key);
    assert.equal(calls[1].body, calls[0].body);
    assert.deepEqual(JSON.parse(texts(r).at(-1)!), ORDER);
  });
});

test('change_billing_cycle: a replayed answer says the invoice was created once, not again', async () => {
  await withFetch([{ body: { ok: true, data: ORDER }, headers: { 'Idempotent-Replayed': 'true' } }], async () => {
    const r = await changeBillingCycle.handler(client(), { service_id: '123', cycle: 'annually', idempotency_key: 'k1', confirm: true });
    const [note, json] = texts(r);
    assert.match(note, /idempotent replay/);
    assert.match(note, /ran once/);
    assert.deepEqual(JSON.parse(json), ORDER);
  });
});

test('change_billing_cycle: the API refusals reach the agent unchanged, after one request', async () => {
  const refusals = [
    'Choose a billing cycle longer than the current one (annually). To move to a shorter cycle, contact support.',
    'The price of the annually cycle is now 61.20 EUR, not the price you were shown. Review the new price and confirm again.',
    'A plan upgrade on your account (invoice #5150) is still open: pay it, or contact support to cancel it, then change the billing cycle.',
    'Invoice #5151 for a billing cycle change on this service is still unpaid. Pay it, or contact support to cancel it.',
    'Billing cycle changes are available for legacy services only.',
  ];
  for (const message of refusals) {
    await withFetch([{ status: 400, body: { ok: false, error: { code: 'INVALID_PARAM', message } } }], async (calls) => {
      const r = await changeBillingCycle.handler(client(), { service_id: '123', cycle: 'annually', expected_amount: 59.4, confirm: true });
      assert.equal(r.isError, true);
      assert.equal(texts(r)[0], `Error: [INVALID_PARAM] ${message}`);
      assert.equal(calls.length, 1, 'a refusal is an answer: it is not retried');
    });
  }
});

test('change_billing_cycle: the description says what it charges, when it applies, and how to read the refusals', () => {
  const d = changeBillingCycle.description;
  assert.match(d, /legacy VPS/);
  assert.match(d, /full list price/);
  assert.match(d, /VAT/);
  assert.match(d, /no paid day is lost/);
  assert.match(d, /Nothing changes before that invoice is paid/);
  assert.match(d, /invoiceId/);
  assert.match(d, /cannot pay/);
  assert.match(d, /within about an hour/);
  assert.match(d, /list_billing_cycle_options/);
  assert.match(d, /expected_amount/);
  assert.match(d, /replacesRenewalInvoiceIds/);
  assert.match(d, /INVALID_PARAM/);
  assert.match(d, /shorter cycle/);
  assert.match(d, /upgrade_service/);
  assert.ok(!d.includes('—'), 'no em dash');
});
