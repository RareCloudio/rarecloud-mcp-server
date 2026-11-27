// quote_domains (POST /v1/domains/quote, read-only) and register_domains
// (POST /v1/domains/bulk, spends): price several domains at once, then register
// them in one order and one invoice. A fake client records each call for the
// request shape; the idempotency tests run through the real client with a
// stubbed fetch so the Idempotency-Key header itself is asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteDomains } from './domains.js';
import { registerDomains, registerDomain } from './domains-write.js';
import { APIError, RareCloudClient, type PostOptions } from '../client.js';
import type { ToolCallResult } from './types.js';

type Call = { method: string; path: string; body?: unknown; opts?: PostOptions };

function fakeClient(impl: (path: string, body?: unknown) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const rec = (method: string) => async (path: string, body?: unknown, opts?: PostOptions) => {
    calls.push({ method, path, body, opts });
    return impl(path, body);
  };
  const client = { get: rec('GET'), post: rec('POST'), put: rec('PUT'), patch: rec('PATCH'), delete: rec('DELETE') };
  return { client: client as unknown as RareCloudClient, calls };
}

const textOf = (r: ToolCallResult) => {
  const block = r.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
};

const QUOTE = {
  type: 'register',
  years: 1,
  currency: 'EUR',
  taxRatePercent: 21,
  items: [
    { domain: 'a.com', status: 'available', orderable: true, perYearCents: 1000, netCents: 1000, message: null },
    { domain: 'b.net', status: 'unavailable', orderable: false, perYearCents: 1200, netCents: 1200, message: 'Already registered.' },
  ],
  subtotalCents: 1000,
  vatCents: 210,
  totalCents: 1210,
  realCreditCents: 500,
  shortfallCents: 710,
  affordable: false,
};

const BULK = {
  orderId: '123',
  invoiceId: '456',
  status: 'Pending',
  domains: [
    { domain: 'a.com', domainId: '77' },
    { domain: 'b.net', domainId: null },
  ],
};

// --- quote_domains ---------------------------------------------------------

test('quote_domains: a read tool with a closed schema of domains (1-20), type and years', () => {
  assert.equal(quoteDomains.name, 'quote_domains');
  assert.deepEqual(quoteDomains.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  const s = quoteDomains.inputSchema;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['domains']);
  assert.deepEqual(Object.keys(s.properties).sort(), ['domains', 'type', 'years']);
  const domains = s.properties.domains as { type: string; minItems: number; maxItems: number; items: { type: string } };
  assert.equal(domains.type, 'array');
  assert.equal(domains.minItems, 1);
  assert.equal(domains.maxItems, 20);
  assert.equal(domains.items.type, 'string');
  assert.deepEqual((s.properties.type as { enum: string[] }).enum, ['register', 'transfer']);
  const years = s.properties.years as { type: string; minimum: number; maximum: number };
  assert.equal(years.type, 'integer');
  assert.equal(years.minimum, 1);
  assert.equal(years.maximum, 10);
  assert.ok(!('confirm' in s.properties));
  assert.ok(!('idempotency_key' in s.properties));
});

test('quote_domains: the description says it places nothing, totals include VAT, real credit only, and to quote before register_domains', () => {
  const d = quoteDomains.description;
  assert.match(d, /places nothing/i);
  assert.match(d, /totalCents includes VAT/);
  assert.match(d, /real credit only, never promotional bonus/);
  assert.match(d, /before register_domains/);
  assert.match(d, /domains:read/);
  assert.ok(!d.includes('Safety:'));
});

test('quote_domains: POSTs {domains} to /v1/domains/quote with no Idempotency-Key and returns the API data', async () => {
  const { client, calls } = fakeClient(() => QUOTE);
  const r = await quoteDomains.handler(client, { domains: ['a.com', 'b.net'] });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/v1/domains/quote');
  assert.deepEqual(calls[0].body, { domains: ['a.com', 'b.net'] });
  assert.equal(calls[0].opts?.idempotent, undefined);
  assert.deepEqual(JSON.parse(textOf(r)), QUOTE);
});

test('quote_domains: forwards type and years when supplied', async () => {
  const { client, calls } = fakeClient(() => QUOTE);
  await quoteDomains.handler(client, { domains: ['a.com'], type: 'transfer', years: 3 });
  assert.deepEqual(calls[0].body, { domains: ['a.com'], type: 'transfer', years: 3 });
});

test('quote_domains: an odd-looking name still goes to the API, which answers it as an invalid item', async () => {
  const { client, calls } = fakeClient(() => QUOTE);
  await quoteDomains.handler(client, { domains: ['not a domain'] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { domains: ['not a domain'] });
});

test('quote_domains: invalid input is refused before any request', async () => {
  for (const bad of [
    {},
    { domains: [] },
    { domains: Array.from({ length: 21 }, (_, i) => `d${i}.com`) },
    { domains: [''] },
    { domains: ['a.com'], type: 'renew' },
    { domains: ['a.com'], years: 0 },
    { domains: ['a.com'], years: 11 },
    { domains: ['a.com'], years: 1.5 },
    { domains: ['a.com'], extra: true },
  ]) {
    const { client, calls } = fakeClient();
    const r = await quoteDomains.handler(client, bad as Record<string, unknown>);
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.match(textOf(r), /^Error: Invalid input for quote_domains:/);
    assert.equal(calls.length, 0, JSON.stringify(bad));
  }
});

test('quote_domains: 20 domains is the limit and is accepted', async () => {
  const { client, calls } = fakeClient(() => QUOTE);
  const r = await quoteDomains.handler(client, { domains: Array.from({ length: 20 }, (_, i) => `d${i}.com`) });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
});

test('quote_domains: an API error passes through as [CODE] message', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'RATE_LIMITED', message: 'Too many availability checks.' });
  });
  const r = await quoteDomains.handler(client, { domains: ['a.com'] });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'Error: [RATE_LIMITED] Too many availability checks.');
});

// --- register_domains ------------------------------------------------------

test('register_domains: a spends tool with a closed schema; confirm required, idempotency_key optional', () => {
  assert.equal(registerDomains.name, 'register_domains');
  assert.deepEqual(registerDomains.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  const s = registerDomains.inputSchema;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['domains', 'confirm']);
  assert.deepEqual(
    Object.keys(s.properties).sort(),
    ['confirm', 'dnsManagement', 'domains', 'idProtection', 'idempotency_key', 'nameservers', 'years'],
  );
  const domains = s.properties.domains as { minItems: number; maxItems: number; items: { type: string } };
  assert.equal(domains.minItems, 1);
  assert.equal(domains.maxItems, 20);
  assert.equal(domains.items.type, 'string');
  const ns = s.properties.nameservers as { maxItems: number; items: { pattern: string } };
  assert.equal(ns.maxItems, 5);
  assert.ok(ns.items.pattern.length > 0);
  const years = s.properties.years as { minimum: number; maximum: number };
  assert.equal(years.minimum, 1);
  assert.equal(years.maximum, 10);
});

test('register_domains: the description names one order and one invoice, real credit only, and quote_domains first', () => {
  const d = registerDomains.description;
  assert.match(d, /ONE order and ONE invoice/);
  assert.match(d, /real credit only, never promotional bonus/);
  assert.match(d, /quote_domains first/);
  assert.match(d, /only after the user approved/);
  assert.match(d, /domains:write/);
  assert.match(d, /BACKEND_UNAVAILABLE/);
  assert.match(d, /Safety: SPENDS MONEY;/);
});

test('register_domains: refuses with NO request when confirm is absent or false', async () => {
  for (const confirm of [undefined, false, 'true']) {
    const { client, calls } = fakeClient(() => BULK);
    const args: Record<string, unknown> = { domains: ['a.com', 'b.net'] };
    if (confirm !== undefined) args.confirm = confirm;
    const r = await registerDomains.handler(client, args);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /^Error: register_domains was NOT executed because it spends money/);
    assert.equal(calls.length, 0);
  }
});

test('register_domains: POSTs {domains} to /v1/domains/bulk on the idempotent path when confirmed', async () => {
  const { client, calls } = fakeClient(() => BULK);
  const r = await registerDomains.handler(client, { domains: ['a.com', 'b.net'], confirm: true });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/v1/domains/bulk');
  assert.deepEqual(calls[0].body, { domains: ['a.com', 'b.net'] });
  assert.ok(calls[0].opts?.idempotent, 'bulk register must use the Idempotency-Key path');
  assert.deepEqual(JSON.parse(textOf(r)), BULK);
});

test('register_domains: forwards years, nameservers, idProtection and dnsManagement; never confirm or the key', async () => {
  const { client, calls } = fakeClient(() => BULK);
  await registerDomains.handler(client, {
    domains: ['a.com'],
    years: 2,
    nameservers: ['ns1.example.com', 'ns2.example.com'],
    idProtection: true,
    dnsManagement: false,
    idempotency_key: 'k-1',
    confirm: true,
  });
  assert.deepEqual(calls[0].body, {
    domains: ['a.com'],
    years: 2,
    nameservers: ['ns1.example.com', 'ns2.example.com'],
    idProtection: true,
    dnsManagement: false,
  });
  assert.equal(calls[0].opts?.idempotent?.key, 'k-1');
});

test('register_domains: invalid input is refused before any request', async () => {
  for (const bad of [
    {},
    { domains: [] },
    { domains: Array.from({ length: 21 }, (_, i) => `d${i}.com`) },
    { domains: [''] },
    { domains: ['a.com'], years: 0 },
    { domains: ['a.com'], years: 11 },
    { domains: ['a.com'], nameservers: ['ns1.example.com', 'ns2.example.com', 'ns3.example.com', 'ns4.example.com', 'ns5.example.com', 'ns6.example.com'] },
    { domains: ['a.com'], nameservers: ['not a host'] },
    { domains: ['a.com'], idProtection: 'yes' },
    { domains: ['a.com'], type: 'transfer' },
  ]) {
    const { client, calls } = fakeClient();
    const r = await registerDomains.handler(client, { ...bad, confirm: true } as Record<string, unknown>);
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.match(textOf(r), /^Error: Invalid input for register_domains:/);
    assert.equal(calls.length, 0, JSON.stringify(bad));
  }
});

test('register_domains: a refusal naming each domain passes through as [CODE] message', async () => {
  const message = "These domains can't be registered: b.net (already registered). Remove them and try again.";
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'INVALID_PARAM', message });
  });
  const r = await registerDomains.handler(client, { domains: ['a.com', 'b.net'], confirm: true });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), `Error: [INVALID_PARAM] ${message}`);
});

test('register_domain is unchanged: still the single-domain POST /v1/domains', async () => {
  const { client, calls } = fakeClient(() => ({ orderId: '1' }));
  await registerDomain.handler(client, { domain: 'example.com', confirm: true });
  assert.equal(calls[0].path, '/v1/domains');
  assert.deepEqual(calls[0].body, { domain: 'example.com' });
  assert.deepEqual(registerDomain.inputSchema.required, ['domain', 'confirm']);
});

// --- Idempotency-Key, through the real client ------------------------------

type Step = { throws: Error } | { status?: number; body: unknown; headers?: Record<string, string> };

function scriptFetch(steps: Step[]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: init?.body as string });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ('throws' in step) throw step.throws;
    const h = new Map(Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: step.status ?? 200,
      headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
      async text() { return JSON.stringify(step.body); },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const realClient = () => new RareCloudClient({ endpoint: 'https://example.com', token: 't', sleep: async () => {} });

test('register_domains: sends the given idempotency_key as the Idempotency-Key header, never in the body', async () => {
  const s = scriptFetch([{ body: { ok: true, data: BULK } }]);
  try {
    const r = await registerDomains.handler(realClient(), { domains: ['a.com'], idempotency_key: 'bulk-1', confirm: true });
    assert.equal(r.isError, undefined);
    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0].url, /\/v1\/domains\/bulk$/);
    assert.equal(s.calls[0].headers['Idempotency-Key'], 'bulk-1');
    assert.deepEqual(JSON.parse(s.calls[0].body!), { domains: ['a.com'] });
  } finally {
    s.restore();
  }
});

test('register_domains: without a key, one is generated and a dropped answer is retried once with that same key', async () => {
  const s = scriptFetch([{ throws: new TypeError('fetch failed') }, { body: { ok: true, data: BULK } }]);
  try {
    const r = await registerDomains.handler(realClient(), { domains: ['a.com'], confirm: true });
    assert.equal(r.isError, undefined);
    assert.equal(s.calls.length, 2);
    const key = s.calls[0].headers['Idempotency-Key'];
    assert.ok(key && key.length > 0);
    assert.equal(s.calls[1].headers['Idempotency-Key'], key);
  } finally {
    s.restore();
  }
});

test('register_domains: a replayed answer is reported to the agent as a replay', async () => {
  const s = scriptFetch([{ body: { ok: true, data: BULK }, headers: { 'Idempotent-Replayed': 'true' } }]);
  try {
    const r = await registerDomains.handler(realClient(), { domains: ['a.com'], idempotency_key: 'bulk-1', confirm: true });
    assert.match(textOf(r), /^Note: idempotent replay\./);
  } finally {
    s.restore();
  }
});

test('register_domains: the confirm gate runs before any key or request', async () => {
  const s = scriptFetch([{ body: { ok: true, data: BULK } }]);
  try {
    const r = await registerDomains.handler(realClient(), { domains: ['a.com'], idempotency_key: 'bulk-1' });
    assert.equal(r.isError, true);
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test('register_domains: the API 503 for a failed availability check passes through, with no automatic retry', async () => {
  // The API answered (a JSON envelope), so this is not a dropped connection: the
  // client does not retry it, and the agent decides, as the description says.
  const message = 'The availability check failed for a.com. Nothing was ordered; try again.';
  const s = scriptFetch([{ status: 503, body: { ok: false, error: { code: 'BACKEND_UNAVAILABLE', message } } }]);
  try {
    const r = await registerDomains.handler(realClient(), { domains: ['a.com'], idempotency_key: 'bulk-1', confirm: true });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: [BACKEND_UNAVAILABLE] ${message}`);
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});

test('quote_domains: through the real client the request carries no Idempotency-Key', async () => {
  const s = scriptFetch([{ body: { ok: true, data: QUOTE } }]);
  try {
    const r = await quoteDomains.handler(realClient(), { domains: ['a.com'] });
    assert.equal(r.isError, undefined);
    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0].url, /\/v1\/domains\/quote$/);
    assert.equal(s.calls[0].headers['Idempotency-Key'], undefined);
  } finally {
    s.restore();
  }
});
