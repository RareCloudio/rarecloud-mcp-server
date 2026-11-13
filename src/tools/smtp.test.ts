// Unit tests for the outbound email (SMTP port 25) tools. A fake client records
// method + path + body (no network); we assert the exact request each tool
// makes, closed schemas, the confirm gate (refusal with NO request), the answer
// rules mirrored from the API's smtpAnswersSchema, traversal guards and the
// APIError -> errorResult mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getServiceSmtp } from './smtp.js';
import { requestSmtpUnblock } from './smtp-write.js';
import { APIError, type RareCloudClient, type PostOptions } from '../client.js';
import type { ToolCallResult } from './types.js';

type Call = { method: string; path: string; body?: unknown; idempotent: boolean };

function fakeClient(impl: (m: string, p: string) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const rec = (method: string) => async (path: string, body?: unknown, opts?: PostOptions) => {
    calls.push({ method, path, body, idempotent: Boolean(opts?.idempotent) });
    return impl(method, path);
  };
  const client = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path, idempotent: false });
      return impl('GET', path);
    },
    post: rec('POST'),
    put: rec('PUT'),
    patch: rec('PATCH'),
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path, idempotent: false });
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

const VM = '7d3c1a2b-1111-4222-8333-944455556666';

const ANSWERS = {
  purpose: 'own_domain_mail',
  software: 'Postfix',
  domains: ['mail.example.com'],
  spf: true,
  dkim: true,
  dmarc: false,
  recipients: 'own_users',
  messagesPerDay: 200,
  acceptPolicy: true,
} as const;

// ---------------------------------------------------------------------------
// get_service_smtp
// ---------------------------------------------------------------------------

test('get_service_smtp: GETs /v1/services/:id/smtp, read-only, closed schema, JSON out', async () => {
  assert.equal(getServiceSmtp.name, 'get_service_smtp');
  assert.equal(getServiceSmtp.annotations.readOnlyHint, true);
  assert.equal(getServiceSmtp.inputSchema.additionalProperties, false);
  assert.deepEqual(getServiceSmtp.inputSchema.required, ['service_id']);
  assert.ok(!getServiceSmtp.description.includes('Safety:'), 'a read carries no Safety sentence');
  const data = { status: 'blocked', request: null, canRequestAfter: null };
  const { client, calls } = fakeClient(() => data);
  const result = await getServiceSmtp.handler(client, { service_id: VM });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`GET /v1/services/${VM}/smtp`]);
  assert.deepEqual(JSON.parse(textOf(result)), data);
});

test('get_service_smtp: description names port 25, the statuses, canRequestAfter, the scope and the request tool', () => {
  const d = getServiceSmtp.description;
  assert.match(d, /port 25/);
  assert.match(d, /new cloud (servers|VMs)/i);
  for (const s of ['open', 'blocked', 'pending', 'approved', 'rejected']) assert.match(d, new RegExp(`\\b${s}\\b`), s);
  assert.match(d, /canRequestAfter/);
  assert.match(d, /services:read/);
  assert.match(d, /request_smtp_unblock/);
});

test('get_service_smtp: the id segment is encoded and traversal tokens make no request', async () => {
  const { client, calls } = fakeClient();
  await getServiceSmtp.handler(client, { service_id: 'a/b' });
  assert.equal(calls[0].path, '/v1/services/a%2Fb/smtp');
  for (const bad of ['..', '.', '']) {
    const r = fakeClient();
    const result = await getServiceSmtp.handler(r.client, { service_id: bad });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.deepEqual(r.calls, [], `must make no request for ${JSON.stringify(bad)}`);
  }
});

test('get_service_smtp: APIError maps to an error result', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'Cloud VM not found.' }, { status: 404 });
  });
  const result = await getServiceSmtp.handler(client, { service_id: VM });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Cloud VM not found/);
});

// ---------------------------------------------------------------------------
// request_smtp_unblock
// ---------------------------------------------------------------------------

test('request_smtp_unblock: a gated sensitive write, closed schema, no idempotency_key', () => {
  const t = requestSmtpUnblock;
  assert.equal(t.name, 'request_smtp_unblock');
  assert.equal(t.annotations.readOnlyHint, false);
  assert.equal(t.annotations.destructiveHint, false);
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.ok('confirm' in t.inputSchema.properties, 'gated by confirm');
  assert.ok(!('idempotency_key' in t.inputSchema.properties), 'the API route is exempt from Idempotency-Key');
  assert.match(t.description, /Safety: SECURITY-SENSITIVE;/);
  assert.match(t.description, /services:write/);
  assert.deepEqual(
    [...(t.inputSchema.required ?? [])].sort(),
    ['acceptPolicy', 'confirm', 'dkim', 'dmarc', 'domains', 'messagesPerDay', 'purpose', 'recipients', 'service_id', 'software', 'spf'].sort(),
  );
});

test('request_smtp_unblock: description says a human decides, a ticket opens, only port 25 is blocked, and the 7-day wait', () => {
  const d = requestSmtpUnblock.description;
  assert.match(d, /human/i);
  assert.match(d, /support ticket/);
  assert.match(d, /only port 25/i);
  assert.match(d, /465/);
  assert.match(d, /587/);
  assert.match(d, /7 days/);
  assert.match(d, /409 CONFLICT/);
  assert.match(d, /canRequestAfter/);
  assert.match(d, /get_service_smtp/);
});

test('request_smtp_unblock: without confirm it refuses and makes NO request', async () => {
  for (const confirm of [undefined, false]) {
    const { client, calls } = fakeClient();
    const args = confirm === undefined ? { service_id: VM, ...ANSWERS } : { service_id: VM, ...ANSWERS, confirm };
    const result = await requestSmtpUnblock.handler(client, args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error: request_smtp_unblock was NOT executed because it is security-sensitive/);
    assert.deepEqual(calls, []);
  }
});

test('request_smtp_unblock: with confirm:true it POSTs the answers (and only the answers) to the unblock-request path', async () => {
  const { client, calls } = fakeClient(() => ({ id: 'req-1', status: 'pending' }));
  const result = await requestSmtpUnblock.handler(client, { service_id: VM, ...ANSWERS, confirm: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `/v1/services/${VM}/smtp/unblock-request`);
  assert.deepEqual(calls[0].body, { ...ANSWERS });
  assert.equal(calls[0].idempotent, false);
  assert.deepEqual(JSON.parse(textOf(result)), { id: 'req-1', status: 'pending' });
});

test('request_smtp_unblock: optional answers are sent when given', async () => {
  const full = {
    ...ANSWERS,
    purpose: 'newsletter',
    listSource: 'Double opt-in signup form on example.com',
    recipients: 'other',
    recipientsOther: 'Members of our community forum who asked for it',
    rdns: 'mail.example.com',
    purposeOther: 'Also sends the weekly digest of new posts',
  };
  const { client, calls } = fakeClient();
  const result = await requestSmtpUnblock.handler(client, { service_id: VM, ...full, confirm: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls[0].body, full);
});

test('request_smtp_unblock: answers that break the API rules are refused before any request', async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...ANSWERS, purpose: 'spam' },
    { ...ANSWERS, purpose: 'other' },
    { ...ANSWERS, purpose: 'other', purposeOther: 'too short' },
    { ...ANSWERS, purpose: 'newsletter' },
    { ...ANSWERS, purpose: 'newsletter', listSource: 'bought it' },
    { ...ANSWERS, recipients: 'other' },
    { ...ANSWERS, recipients: 'other', recipientsOther: 'everyone' },
    { ...ANSWERS, recipients: 'anyone' },
    { ...ANSWERS, software: 'x' },
    { ...ANSWERS, software: 'x'.repeat(201) },
    { ...ANSWERS, domains: [] },
    { ...ANSWERS, domains: Array.from({ length: 11 }, (_, i) => `d${i}.example.com`) },
    { ...ANSWERS, domains: ['not a domain'] },
    { ...ANSWERS, domains: ['localhost'] },
    { ...ANSWERS, rdns: 'bad host' },
    { ...ANSWERS, spf: 'yes' },
    { ...ANSWERS, messagesPerDay: 0 },
    { ...ANSWERS, messagesPerDay: 1_000_001 },
    { ...ANSWERS, messagesPerDay: 1.5 },
    { ...ANSWERS, acceptPolicy: false },
    { ...ANSWERS, purposeOther: 'x'.repeat(2001), purpose: 'other' },
    { ...ANSWERS, extra: 1 },
  ];
  for (const answers of cases) {
    const { client, calls } = fakeClient();
    const result = await requestSmtpUnblock.handler(client, { service_id: VM, ...answers, confirm: true });
    assert.equal(result.isError, true, JSON.stringify(answers).slice(0, 160));
    assert.match(textOf(result), /Invalid input for request_smtp_unblock/);
    assert.deepEqual(calls, [], JSON.stringify(answers).slice(0, 160));
  }
  for (const key of Object.keys(ANSWERS)) {
    const { client, calls } = fakeClient();
    const answers: Record<string, unknown> = { ...ANSWERS };
    delete answers[key];
    const result = await requestSmtpUnblock.handler(client, { service_id: VM, ...answers, confirm: true });
    assert.equal(result.isError, true, `missing ${key}`);
    assert.deepEqual(calls, [], `missing ${key}`);
  }
});

test('request_smtp_unblock: the JSON schema advertises the same bounds as the zod input', () => {
  const p = requestSmtpUnblock.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(p.purpose.enum, ['own_domain_mail', 'transactional', 'newsletter', 'other']);
  assert.deepEqual(p.recipients.enum, ['own_users', 'opted_in', 'other']);
  for (const k of ['purposeOther', 'recipientsOther', 'listSource']) {
    assert.equal(p[k].minLength, 20, k);
    assert.equal(p[k].maxLength, 2000, k);
  }
  assert.equal(p.software.minLength, 2);
  assert.equal(p.software.maxLength, 200);
  assert.equal(p.domains.minItems, 1);
  assert.equal(p.domains.maxItems, 10);
  assert.equal(p.messagesPerDay.type, 'integer');
  assert.equal(p.messagesPerDay.minimum, 1);
  assert.equal(p.messagesPerDay.maximum, 1_000_000);
  assert.deepEqual(p.acceptPolicy.enum, [true]);
  for (const k of ['spf', 'dkim', 'dmarc']) assert.equal(p[k].type, 'boolean', k);
  assert.match(String(p.purposeOther.description), /purpose is other/);
  assert.match(String(p.recipientsOther.description), /recipients is other/);
  assert.match(String(p.listSource.description), /purpose is newsletter/);
});

test('request_smtp_unblock: uppercase hostnames pass both the zod input and the JSON schema pattern, like the API', async () => {
  const p = requestSmtpUnblock.inputSchema.properties as Record<string, Record<string, unknown>>;
  const domainRe = new RegExp(String((p.domains.items as Record<string, unknown>).pattern));
  const rdnsRe = new RegExp(String(p.rdns.pattern));
  for (const host of ['Mail.Example.com', 'MAIL.EXAMPLE.COM', 'mail.example.com']) {
    assert.ok(domainRe.test(host), `domains pattern accepts ${host}`);
    assert.ok(rdnsRe.test(host), `rdns pattern accepts ${host}`);
  }
  for (const host of ['localhost', 'bad host', 'example.123']) {
    assert.ok(!domainRe.test(host), `domains pattern refuses ${host}`);
    assert.ok(!rdnsRe.test(host), `rdns pattern refuses ${host}`);
  }
  const { client, calls } = fakeClient();
  const result = await requestSmtpUnblock.handler(client, {
    service_id: VM, ...ANSWERS, domains: ['Mail.Example.com'], rdns: 'MAIL.EXAMPLE.COM', confirm: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual((calls[0].body as Record<string, unknown>).domains, ['Mail.Example.com']);
});

test('request_smtp_unblock: the 409 sentence says the message names the date and get_service_smtp returns canRequestAfter', () => {
  assert.match(requestSmtpUnblock.description, /409 CONFLICT whose message names the date/);
  assert.match(requestSmtpUnblock.description, /get_service_smtp returns it as canRequestAfter/);
});

test('request_smtp_unblock: traversal tokens in service_id make no request', async () => {
  for (const bad of ['..', '.']) {
    const { client, calls } = fakeClient();
    const result = await requestSmtpUnblock.handler(client, { service_id: bad, ...ANSWERS, confirm: true });
    assert.equal(result.isError, true, bad);
    assert.deepEqual(calls, [], bad);
  }
});

test('request_smtp_unblock: a 409 CONFLICT with the cooldown date maps to an error result', async () => {
  const { client } = fakeClient(() => {
    throw new APIError(
      { code: 'CONFLICT', message: 'A request for this server was rejected or revoked recently. You can send a new request after 9 November 2026.' },
      { status: 409 },
    );
  });
  const result = await requestSmtpUnblock.handler(client, { service_id: VM, ...ANSWERS, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /\[CONFLICT\].*9 November 2026/);
});
