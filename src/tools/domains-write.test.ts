// Unit tests for the Parity Phase B domains WRITE tools (Task 7): register /
// transfer / renew (money-spend, confirm-gated) and set-nameservers /
// set-contacts / set-dns / manage (plain writes). A fake client records
// method+path+body (no network); we assert closed schemas, path + segment
// encoding, exact body shapes (incl. omit-undefined optionals), the confirm
// gate, the traversal guard on every dynamic `id` segment, and both-layer
// (zod + JSON inputSchema) constraint mirrors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerDomain,
  transferDomain,
  renewDomain,
  setDomainNameservers,
  setDomainContacts,
  setDomainDns,
  manageDomain,
} from './domains-write.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

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
// Shared table: the 5 tools with a single dynamic path segment, `id`.
// (register_domain, transfer_domain have NO id segment — they create new
// order-driven resources — and get their own dedicated tests further down.)
// ---------------------------------------------------------------------------
type IdToolCase = {
  tool: ToolDefinition;
  gated: boolean; // advertises confirm
  destructive: boolean; // advertises annotations.destructiveHint
  args: Record<string, unknown>; // required domain args minus id
};

const ID_TOOLS: Record<string, IdToolCase> = {
  renew_domain: { tool: renewDomain, gated: true, destructive: false, args: {} },
  set_domain_nameservers: {
    tool: setDomainNameservers,
    gated: false,
    destructive: false,
    args: { nameservers: ['ns1.example.com', 'ns2.example.com'] },
  },
  set_domain_contacts: { tool: setDomainContacts, gated: false, destructive: false, args: { contact: {} } },
  set_domain_dns: {
    tool: setDomainDns,
    gated: false,
    destructive: false,
    args: { records: [{ hostname: '@', type: 'A', address: '203.0.113.10' }] },
  },
  manage_domain: { tool: manageDomain, gated: false, destructive: false, args: { action: 'lock', enabled: true } },
};

test('task7 registry: each id-tool has its name, closed schema, requires id, domains:write in description', () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.match(c.tool.description, /domains:write/, `${name} description must name the scope`);
    assert.ok((c.tool.inputSchema.required ?? []).includes('id'), `${name} must require id`);
  }
});

test('task7 gates: confirm advertised iff gated; destructiveHint iff destructive', () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    const hasConfirm = 'confirm' in c.tool.inputSchema.properties;
    assert.equal(hasConfirm, c.gated, `${name}: confirm-in-schema must match gated=${c.gated}`);
    if (c.gated) {
      assert.ok((c.tool.inputSchema.required ?? []).includes('confirm'), `${name}: gated tool must require confirm`);
    } else {
      assert.ok(!('confirm' in c.tool.inputSchema.properties), `${name}: non-gated tool must not advertise confirm`);
    }
    assert.equal(
      c.tool.annotations?.destructiveHint ?? false,
      c.destructive,
      `${name}: destructiveHint must match destructive=${c.destructive}`,
    );
  }
});

test('task7 confirm gate: gated tools refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { id: 'dom-1', ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('task7 traversal guard: a ".." id is rejected before any request', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { id: '..', ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

test('task7 APIError mapping: a representative tool maps [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'domains:write scope required' });
  });
  const result = await manageDomain.handler(client, { id: 'dom-1', action: 'lock', enabled: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] domains:write scope required');
});

// --- register_domain (POST /v1/domains, confirm — order → money-spend) -----

test('register_domain: name + closed schema (confirm — money-spend)', () => {
  assert.equal(registerDomain.name, 'register_domain');
  assert.match(registerDomain.description, /domains:write/);
  assert.deepEqual(registerDomain.inputSchema.required, ['domain', 'confirm']);
  assert.equal(registerDomain.inputSchema.additionalProperties, false);
  assert.equal(registerDomain.annotations, undefined);
});

test('register_domain: POSTs {domain} to /v1/domains when confirmed (optionals omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registerDomain.handler(client, { domain: 'example.com', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/domains', body: { domain: 'example.com' } }]);
});

test('register_domain: forwards years/nameservers/idProtection/dnsManagement when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registerDomain.handler(client, {
    domain: 'example.com',
    years: 2,
    nameservers: ['ns1.example.com', 'ns2.example.com'],
    idProtection: true,
    dnsManagement: false,
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/domains',
      body: {
        domain: 'example.com',
        years: 2,
        nameservers: ['ns1.example.com', 'ns2.example.com'],
        idProtection: true,
        dnsManagement: false,
      },
    },
  ]);
});

test('register_domain: refuses with NO request when confirm is absent', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registerDomain.handler(client, { domain: 'example.com' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

test('register_domain: rejects a malformed domain before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registerDomain.handler(client, { domain: 'not a domain', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for register_domain:/);
  assert.deepEqual(calls, []);
});

test('register_domain: rejects years below 1 / above 10 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const years of [0, 11]) {
    const result = await registerDomain.handler(client, { domain: 'example.com', years, confirm: true });
    assert.equal(result.isError, true, `years=${years} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for register_domain:/);
  }
  assert.deepEqual(calls, []);
});

test('register_domain: rejects nameservers over 5 items before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registerDomain.handler(client, {
    domain: 'example.com',
    nameservers: ['ns1.example.com', 'ns2.example.com', 'ns3.example.com', 'ns4.example.com', 'ns5.example.com', 'ns6.example.com'],
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for register_domain:/);
  assert.deepEqual(calls, []);
});

test('register_domain: rejects a malformed nameserver hostname before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await registerDomain.handler(client, {
    domain: 'example.com',
    nameservers: ['not_a_valid_ns'],
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for register_domain:/);
  assert.deepEqual(calls, []);
});

test('register_domain: schema mirrors years bounds, nameservers maxItems, and domain/nameserver patterns', () => {
  const props = registerDomain.inputSchema.properties as Record<
    string,
    { minimum?: number; maximum?: number; maxItems?: number; pattern?: string; items?: { pattern?: string } }
  >;
  assert.equal(props.years.minimum, 1);
  assert.equal(props.years.maximum, 10);
  assert.equal(props.nameservers.maxItems, 5);
  assert.ok(props.domain.pattern, 'domain must carry a hostname-format pattern');
  assert.ok(props.nameservers.items?.pattern, 'nameservers items must carry a hostname-format pattern');
});

// --- transfer_domain (POST /v1/domains/transfers, confirm — money-spend) ---

test('transfer_domain: name + closed schema (confirm — money-spend)', () => {
  assert.equal(transferDomain.name, 'transfer_domain');
  assert.match(transferDomain.description, /domains:write/);
  assert.deepEqual(transferDomain.inputSchema.required, ['domain', 'epp', 'confirm']);
  assert.equal(transferDomain.annotations, undefined);
});

test('transfer_domain: POSTs {domain, epp} to /v1/domains/transfers when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await transferDomain.handler(client, { domain: 'example.com', epp: 'EPP-CODE-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/domains/transfers', body: { domain: 'example.com', epp: 'EPP-CODE-1' } },
  ]);
});

test('transfer_domain: forwards years/nameservers/idProtection when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await transferDomain.handler(client, {
    domain: 'example.com',
    epp: 'EPP-CODE-1',
    years: 3,
    nameservers: ['ns1.example.com', 'ns2.example.com'],
    idProtection: true,
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/domains/transfers',
      body: {
        domain: 'example.com',
        epp: 'EPP-CODE-1',
        years: 3,
        nameservers: ['ns1.example.com', 'ns2.example.com'],
        idProtection: true,
      },
    },
  ]);
});

test('transfer_domain: refuses with NO request when confirm is absent', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await transferDomain.handler(client, { domain: 'example.com', epp: 'EPP-CODE-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

test('transfer_domain: rejects a missing epp before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await transferDomain.handler(client, { domain: 'example.com', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for transfer_domain:/);
  assert.deepEqual(calls, []);
});

test('transfer_domain: schema mirrors years bounds and nameservers maxItems', () => {
  const props = transferDomain.inputSchema.properties as Record<string, { minimum?: number; maximum?: number; maxItems?: number }>;
  assert.equal(props.years.minimum, 1);
  assert.equal(props.years.maximum, 10);
  assert.equal(props.nameservers.maxItems, 5);
});

// --- renew_domain (POST /v1/domains/{id}/renew, confirm — money-spend) -----

test('renew_domain: POSTs an empty body to /v1/domains/{id}/renew when confirmed (optionals omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await renewDomain.handler(client, { id: 'dom-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/domains/dom-1/renew', body: {} }]);
});

test('renew_domain: forwards years and autoRenew when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await renewDomain.handler(client, { id: 'dom-1', years: 2, autoRenew: true, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/domains/dom-1/renew', body: { years: 2, autoRenew: true } }]);
});

test('renew_domain: rejects years below 1 / above 10 before any request', async () => {
  const { client, calls } = fakeWriteClient();
  for (const years of [0, 11]) {
    const result = await renewDomain.handler(client, { id: 'dom-1', years, confirm: true });
    assert.equal(result.isError, true, `years=${years} must be rejected`);
  }
  assert.deepEqual(calls, []);
});

test('renew_domain: schema mirrors years bounds', () => {
  const props = renewDomain.inputSchema.properties as Record<string, { minimum?: number; maximum?: number }>;
  assert.equal(props.years.minimum, 1);
  assert.equal(props.years.maximum, 10);
});

// --- set_domain_nameservers (PUT /v1/domains/{id}/nameservers, no gate) ----
// DEVIATION FROM BRIEF: brief said nameservers:string[].min(1); openapi's PUT
// /domains/{id}/nameservers request schema (AND the route source's
// NameserversInput) both require minItems:2, maxItems:5. openapi wins.

test('set_domain_nameservers: PUTs {nameservers} to /v1/domains/{id}/nameservers', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainNameservers.handler(client, {
    id: 'dom-1',
    nameservers: ['ns1.example.com', 'ns2.example.com'],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PUT', path: '/v1/domains/dom-1/nameservers', body: { nameservers: ['ns1.example.com', 'ns2.example.com'] } },
  ]);
});

test('set_domain_nameservers: rejects fewer than 2 nameservers before any request (deviation: brief said min 1)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainNameservers.handler(client, { id: 'dom-1', nameservers: ['ns1.example.com'] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_domain_nameservers:/);
  assert.deepEqual(calls, []);
});

test('set_domain_nameservers: rejects more than 5 nameservers before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainNameservers.handler(client, {
    id: 'dom-1',
    nameservers: ['ns1.example.com', 'ns2.example.com', 'ns3.example.com', 'ns4.example.com', 'ns5.example.com', 'ns6.example.com'],
  });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('set_domain_nameservers: rejects a malformed nameserver hostname before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainNameservers.handler(client, { id: 'dom-1', nameservers: ['ns1.example.com', 'not_valid'] });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('set_domain_nameservers: schema mirrors minItems:2 (deviation from brief) and maxItems:5', () => {
  const props = setDomainNameservers.inputSchema.properties as Record<string, { minItems?: number; maxItems?: number }>;
  assert.equal(props.nameservers.minItems, 2);
  assert.equal(props.nameservers.maxItems, 5);
});

// --- set_domain_contacts (PUT /v1/domains/{id}/contacts, no gate) ----------

test('set_domain_contacts: name + closed schema (no confirm)', () => {
  assert.equal(setDomainContacts.name, 'set_domain_contacts');
  assert.match(setDomainContacts.description, /domains:write/);
  assert.deepEqual(setDomainContacts.inputSchema.required, ['id', 'contact']);
  assert.ok(!('confirm' in setDomainContacts.inputSchema.properties));
});

test('set_domain_contacts: PUTs only the provided contact fields to /v1/domains/{id}/contacts', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainContacts.handler(client, {
    id: 'dom-1',
    contact: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', country: 'RO' },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'PUT',
      path: '/v1/domains/dom-1/contacts',
      body: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', country: 'RO' },
    },
  ]);
});

test('set_domain_contacts: PUTs an empty body when contact has no fields', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainContacts.handler(client, { id: 'dom-1', contact: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PUT', path: '/v1/domains/dom-1/contacts', body: {} }]);
});

test('set_domain_contacts: rejects a malformed email before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainContacts.handler(client, { id: 'dom-1', contact: { email: 'not-an-email' } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_domain_contacts:/);
  assert.deepEqual(calls, []);
});

test('set_domain_contacts: rejects a country code that is not exactly 2 letters', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainContacts.handler(client, { id: 'dom-1', contact: { country: 'ROU' } });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

// Task 10 review: firstName/lastName min(1) enrichment (route source's
// ContactsInput enforces .min(1) on both; openapi is silent on the minimum)
// was implemented but undocumented/untested — mirror-assertion added here.
test('set_domain_contacts: rejects an empty firstName/lastName before any request (enrichment: route requires min(1))', async () => {
  const { client, calls } = fakeWriteClient();
  for (const contact of [{ firstName: '' }, { lastName: '' }]) {
    const result = await setDomainContacts.handler(client, { id: 'dom-1', contact });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error: Invalid input for set_domain_contacts:/);
  }
  assert.deepEqual(calls, []);
});

test('set_domain_contacts: rejects an unknown contact property (strict nested schema)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainContacts.handler(client, { id: 'dom-1', contact: { nickname: 'Ada' } });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('set_domain_contacts: schema mirrors email format, country length, and firstName/lastName minLength:1', () => {
  const props = setDomainContacts.inputSchema.properties as {
    contact: { properties: Record<string, { format?: string; minLength?: number; maxLength?: number }> };
  };
  assert.equal(props.contact.properties.email.format, 'email');
  assert.equal(props.contact.properties.country.minLength, 2);
  assert.equal(props.contact.properties.country.maxLength, 2);
  assert.equal(props.contact.properties.firstName.minLength, 1);
  assert.equal(props.contact.properties.lastName.minLength, 1);
});

// --- set_domain_dns (PUT /v1/domains/{id}/dns, no gate) ---------------------

test('set_domain_dns: PUTs {records} to /v1/domains/{id}/dns (priority omitted when absent)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainDns.handler(client, {
    id: 'dom-1',
    records: [{ hostname: '@', type: 'A', address: '203.0.113.10' }],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PUT', path: '/v1/domains/dom-1/dns', body: { records: [{ hostname: '@', type: 'A', address: '203.0.113.10' }] } },
  ]);
});

test('set_domain_dns: forwards priority when supplied (MX record)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainDns.handler(client, {
    id: 'dom-1',
    records: [{ hostname: '@', type: 'MX', address: 'mail.example.com', priority: 10 }],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'PUT',
      path: '/v1/domains/dom-1/dns',
      body: { records: [{ hostname: '@', type: 'MX', address: 'mail.example.com', priority: 10 }] },
    },
  ]);
});

test('set_domain_dns: rejects an invalid record type before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainDns.handler(client, {
    id: 'dom-1',
    records: [{ hostname: '@', type: 'BOGUS', address: '203.0.113.10' }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_domain_dns:/);
  assert.deepEqual(calls, []);
});

test('set_domain_dns: rejects a negative priority before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainDns.handler(client, {
    id: 'dom-1',
    records: [{ hostname: '@', type: 'MX', address: 'mail.example.com', priority: -1 }],
  });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('set_domain_dns: rejects an empty records array element field before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setDomainDns.handler(client, { id: 'dom-1', records: [{ hostname: '', type: 'A', address: '203.0.113.10' }] });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('set_domain_dns: schema mirrors DNS record type enum', () => {
  const props = setDomainDns.inputSchema.properties as {
    records: { items: { properties: { type: { enum?: string[] } } } };
  };
  assert.deepEqual(props.records.items.properties.type.enum, ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']);
});

// --- manage_domain (POST /v1/domains/{id}/manage, no gate) -----------------

test('manage_domain: name + closed schema, action enum required', () => {
  assert.equal(manageDomain.name, 'manage_domain');
  assert.match(manageDomain.description, /domains:write/);
  assert.deepEqual(manageDomain.inputSchema.required, ['id', 'action']);
  const props = manageDomain.inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(props.action.enum, ['nameservers', 'lock', 'autorenew', 'idprotect', 'epp']);
});

// Task 10 review: the description must disclose the server's asymmetric
// omitted-enabled defaults (route v1-domains.ts:376-384) — lock/autorenew
// default true, idprotect defaults false — so a caller never accidentally
// relies on an unstated default.
test('manage_domain: description discloses the asymmetric omitted-enabled defaults', () => {
  assert.match(manageDomain.description, /lock and autorenew default to true/);
  assert.match(manageDomain.description, /idprotect defaults to false/);
});

test('manage_domain: POSTs {action} to /v1/domains/{id}/manage (nameservers/enabled omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageDomain.handler(client, { id: 'dom-1', action: 'epp' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/domains/dom-1/manage', body: { action: 'epp' } }]);
});

test('manage_domain: forwards enabled for a lock/autorenew/idprotect action', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageDomain.handler(client, { id: 'dom-1', action: 'lock', enabled: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/domains/dom-1/manage', body: { action: 'lock', enabled: true } }]);
});

test('manage_domain: forwards nameservers for a nameservers action', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageDomain.handler(client, {
    id: 'dom-1',
    action: 'nameservers',
    nameservers: ['ns1.example.com', 'ns2.example.com'],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/domains/dom-1/manage',
      body: { action: 'nameservers', nameservers: ['ns1.example.com', 'ns2.example.com'] },
    },
  ]);
});

test('manage_domain: rejects an unknown action before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageDomain.handler(client, { id: 'dom-1', action: 'delete_everything' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for manage_domain:/);
  assert.deepEqual(calls, []);
});

test('manage_domain: rejects fewer than 2 nameservers when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await manageDomain.handler(client, { id: 'dom-1', action: 'nameservers', nameservers: ['ns1.example.com'] });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});
