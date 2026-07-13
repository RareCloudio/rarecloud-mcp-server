// Unit tests for the domain read tools. Task 5 splits domains out of infra.ts
// into their own module: the relocated list_domains / get_domain plus the new
// availability check, TLD pricing, and the per-domain nameservers / contacts /
// DNS / management-snapshot reads. A fake client records the constructed path
// and returns a canned payload — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listDomains,
  getDomain,
  checkDomainAvailability,
  getTldPricing,
  getDomainNameservers,
  getDomainContacts,
  getDomainDns,
  getDomainManagement,
} from './domains.js';
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

// --- relocated fixed reads (list_domains) + single-id read (get_domain) ----

test('domains: list_domains — name, GETs /v1/domains, empty closed schema', async () => {
  assert.equal(listDomains.name, 'list_domains');
  assert.ok(listDomains.description.trim().length > 0);
  assert.deepEqual(listDomains.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  const { client, calls } = fakeClient(() => [{ id: 'dom-1' }]);
  const result = await listDomains.handler(client, {});
  assert.deepEqual(calls, ['/v1/domains']);
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: 'dom-1' }]);
});

test('domains: get_domain — encodes id into /v1/domains/{id}, closed schema requires id', async () => {
  assert.equal(getDomain.name, 'get_domain');
  assert.deepEqual(getDomain.inputSchema.required, ['id']);
  assert.equal(getDomain.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(getDomain.inputSchema.properties), ['id']);
  const { client, calls } = fakeClient(() => ({ id: 'a b/c' }));
  await getDomain.handler(client, { id: 'a b/c' });
  assert.deepEqual(calls, ['/v1/domains/a%20b%2Fc']);
});

// --- check_domain_availability (required `domain` query param) -------------

test('domains: check_domain_availability — name + closed schema requires only `domain`', () => {
  assert.equal(checkDomainAvailability.name, 'check_domain_availability');
  assert.deepEqual(checkDomainAvailability.inputSchema.required, ['domain']);
  assert.equal(checkDomainAvailability.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(checkDomainAvailability.inputSchema.properties), ['domain']);
});

test('domains: check_domain_availability — puts `domain` in the query string', async () => {
  const { client, calls } = fakeClient(() => ({ available: true }));
  await checkDomainAvailability.handler(client, { domain: 'example.com' });
  assert.deepEqual(calls, ['/v1/domains/availability?domain=example.com']);
});

test('domains: check_domain_availability — encodes special chars in `domain`', async () => {
  const { client, calls } = fakeClient(() => ({ available: false }));
  await checkDomainAvailability.handler(client, { domain: 'ex ample.com' });
  assert.deepEqual(calls, ['/v1/domains/availability?domain=ex+ample.com']);
});

test('domains: check_domain_availability — returns the payload as JSON text', async () => {
  const { client } = fakeClient(() => ({ domain: 'example.com', available: true }));
  const result = await checkDomainAvailability.handler(client, { domain: 'example.com' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { domain: 'example.com', available: true });
});

test('domains: check_domain_availability — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'domains:read required' });
  });
  const result = await checkDomainAvailability.handler(client, { domain: 'example.com' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] domains:read required');
});

// --- get_tld_pricing (fixed, no input) -------------------------------------

test('domains: get_tld_pricing — name, GETs /v1/domains/tld-pricing, empty closed schema', async () => {
  assert.equal(getTldPricing.name, 'get_tld_pricing');
  assert.ok(getTldPricing.description.trim().length > 0);
  assert.deepEqual(getTldPricing.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  const { client, calls } = fakeClient(() => [{ tld: 'com', register: 9.99 }]);
  const result = await getTldPricing.handler(client, {});
  assert.deepEqual(calls, ['/v1/domains/tld-pricing']);
  assert.equal(result.isError, undefined);
});

// --- per-domain sub-path reads (nameservers / contacts / dns / manage) -----
// [tool, name, suffix] — path is /v1/domains/{id}{suffix}, JSON out.
const idScoped: Array<[ToolDefinition, string, string]> = [
  [getDomainNameservers, 'get_domain_nameservers', '/nameservers'],
  [getDomainContacts, 'get_domain_contacts', '/contacts'],
  [getDomainDns, 'get_domain_dns', '/dns'],
  [getDomainManagement, 'get_domain_management', '/manage'],
];

for (const [tool, name, suffix] of idScoped) {
  test(`domains: ${name} — encodes id into /v1/domains/{id}${suffix}`, async () => {
    assert.equal(tool.name, name);
    assert.ok(tool.description.trim().length > 0, `empty description for ${name}`);
    const { client, calls } = fakeClient(() => ({ ok: true }));
    await tool.handler(client, { id: 'dom 1/2' });
    assert.deepEqual(calls, [`/v1/domains/dom%201%2F2${suffix}`]);
  });

  test(`domains: ${name} — requires id (closed schema, only id)`, () => {
    assert.deepEqual(tool.inputSchema.required, ['id']);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id']);
  });

  test(`domains: ${name} — returns the payload as JSON text`, async () => {
    const { client } = fakeClient(() => ({ records: [{ type: 'A', value: '203.0.113.10' }] }));
    const result = await tool.handler(client, { id: 'dom-123' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(result)), { records: [{ type: 'A', value: '203.0.113.10' }] });
  });

  test(`domains: ${name} — APIError maps to errorResult`, async () => {
    const { client } = fakeClient(() => {
      throw new APIError({ code: 'NOT_FOUND', message: 'no such domain' });
    });
    const result = await tool.handler(client, { id: 'dom-123' });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Error: [NOT_FOUND] no such domain');
  });
}

// The nameservers / contacts / dns reads pair with write-side setters that are
// not part of this read-only server yet — the descriptions must flag that so an
// agent doesn't try to mutate through them.
test('domains: nameservers / contacts / dns descriptions flag read-only (setter not exposed yet)', () => {
  assert.match(getDomainNameservers.description, /read-only/i);
  assert.match(getDomainNameservers.description, /not exposed/i);
  assert.match(getDomainContacts.description, /read-only/i);
  assert.match(getDomainContacts.description, /not exposed/i);
  assert.match(getDomainDns.description, /read-only/i);
  assert.match(getDomainDns.description, /not exposed/i);
});
