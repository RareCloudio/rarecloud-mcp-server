// Unit tests for the Parity Phase B proxies WRITE tools (Task 9): order (the
// `oneOf` union) / renew / auto-renew / cancel / auth-method / credentials /
// whitelist add+remove / replacement request / GB proxy-request create+
// delete. A fake client records method+path+body (no network); we assert
// closed schemas, the services:write scope callout (with the "shares scope
// with VM/k8s" note), path + segment encoding, exact body shapes (incl.
// omit-undefined optionals), the confirm gate, the traversal guard on every
// dynamic `id` segment, both-layer constraint mirrors, the two `order_proxy`
// union branches + a cross-branch-confusion rejection, and secret-hygiene
// for set_proxy_credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderProxy,
  renewProxy,
  setProxyAutoRenew,
  cancelProxy,
  setProxyAuthMethod,
  setProxyCredentials,
  addProxyWhitelistedIp,
  removeProxyWhitelistedIp,
  requestProxyReplacement,
  createProxyRequest,
  deleteProxyRequest,
} from './proxies-write.js';
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
// Shared table: the 10 id-scoped tools (order_proxy has no id — it creates a
// new service — and gets its own dedicated tests further down).
// ---------------------------------------------------------------------------
type IdToolCase = {
  tool: ToolDefinition;
  gated: boolean; // advertises confirm
  destructive: boolean; // advertises annotations.destructiveHint
  args: Record<string, unknown>; // required domain args minus id
};

const ID_TOOLS: Record<string, IdToolCase> = {
  renew_proxy: { tool: renewProxy, gated: true, destructive: false, args: {} },
  set_proxy_auto_renew: { tool: setProxyAutoRenew, gated: false, destructive: false, args: { enabled: true } },
  cancel_proxy: { tool: cancelProxy, gated: true, destructive: true, args: {} },
  set_proxy_auth_method: { tool: setProxyAuthMethod, gated: false, destructive: false, args: { method: 'password' } },
  set_proxy_credentials: {
    tool: setProxyCredentials,
    gated: false,
    destructive: false,
    args: { username: 'proxyuser', password: 'proxypass1' },
  },
  add_proxy_whitelisted_ip: { tool: addProxyWhitelistedIp, gated: false, destructive: false, args: { ip: '203.0.113.5' } },
  remove_proxy_whitelisted_ip: {
    tool: removeProxyWhitelistedIp,
    gated: true,
    destructive: true,
    args: { ip: '203.0.113.5' },
  },
  request_proxy_replacement: { tool: requestProxyReplacement, gated: false, destructive: false, args: {} },
  create_proxy_request: {
    tool: createProxyRequest,
    gated: false,
    destructive: false,
    args: { countryId: 1, proxyCount: 5, rotationInterval: 'high' },
  },
};

test('task9 registry: each id-tool has its name, closed schema, requires id, services:write in description', () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.match(c.tool.description, /services:write/, `${name} description must name the scope`);
    assert.match(
      c.tool.description,
      /no proxy-specific scope/,
      `${name} description must call out the shared-scope-with-VMs note`,
    );
    assert.ok((c.tool.inputSchema.required ?? []).includes('id'), `${name} must require id`);
  }
});

test('task9 gates: confirm advertised iff gated; destructiveHint iff destructive', () => {
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

test('task9 confirm gate: gated tools refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { id: 'proxy-1', ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('task9 traversal guard: a ".." id is rejected before any request', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { id: '..', ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

test('task9 APIError mapping: a representative tool maps [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await setProxyAutoRenew.handler(client, { id: 'proxy-1', enabled: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});

// --- order_proxy (POST /v1/proxies, confirm — money-spend; oneOf union) ---

test('order_proxy: name + closed schema (confirm — money-spend, no destructiveHint)', () => {
  assert.equal(orderProxy.name, 'order_proxy');
  assert.match(orderProxy.description, /services:write/);
  assert.match(orderProxy.description, /no proxy-specific scope/);
  assert.deepEqual(orderProxy.inputSchema.required, ['confirm']);
  assert.equal(orderProxy.inputSchema.additionalProperties, false);
  assert.equal(orderProxy.annotations, undefined);
});

test('order_proxy: ISP branch POSTs the full body to /v1/proxies when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, {
    ips: 10,
    cycle: 'month',
    locationId: 'us-east',
    protocol: 'http',
    authType: 'password',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/proxies',
      body: { ips: 10, cycle: 'month', locationId: 'us-east', protocol: 'http', authType: 'password' },
    },
  ]);
});

test('order_proxy: ISP branch accepts an explicit kind:"residential-isp"', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, {
    kind: 'residential-isp',
    ips: 5,
    cycle: 'day',
    locationId: 'eu-west',
    protocol: 'socks',
    authType: 'combined',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/proxies',
      body: { kind: 'residential-isp', ips: 5, cycle: 'day', locationId: 'eu-west', protocol: 'socks', authType: 'combined' },
    },
  ]);
});

test('order_proxy: GB branch POSTs {kind, gb} to /v1/proxies when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, { kind: 'residential-gb', gb: 100, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/proxies', body: { kind: 'residential-gb', gb: 100 } }]);
});

test('order_proxy: refuses with NO request when confirm is absent (either branch)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, { kind: 'residential-gb', gb: 100 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

test('order_proxy: rejects an incomplete ISP body before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, { ips: 10, cycle: 'month', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for order_proxy:/);
  assert.deepEqual(calls, []);
});

test('order_proxy: rejects GB Residential missing kind before any request (kind is required on that branch)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, { gb: 100, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for order_proxy:/);
  assert.deepEqual(calls, []);
});

test('order_proxy: BRANCH-CONFUSION — GB fields on an ISP kind is rejected with zero calls', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, { kind: 'residential-isp', gb: 100, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for order_proxy:/);
  assert.deepEqual(calls, []);
});

test('order_proxy: BRANCH-CONFUSION — ISP fields on a GB kind is rejected with zero calls', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await orderProxy.handler(client, {
    kind: 'residential-gb',
    ips: 10,
    cycle: 'month',
    locationId: 'us-east',
    protocol: 'http',
    authType: 'password',
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for order_proxy:/);
  assert.deepEqual(calls, []);
});

test('order_proxy: JSON inputSchema documents both branches\' fields with enums', () => {
  const props = orderProxy.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>;
  assert.deepEqual(props.kind.enum, ['residential-isp', 'residential-gb']);
  assert.deepEqual(props.cycle.enum, ['day', 'week', 'month']);
  assert.deepEqual(props.protocol.enum, ['http', 'socks']);
  assert.deepEqual(props.authType.enum, ['password', 'combined']);
  assert.equal(props.ips.type, 'integer');
  assert.equal(props.gb.type, 'integer');
});

// --- renew_proxy (POST /v1/proxies/{id}/renew, confirm — money-spend) -----
// DEVIATION FROM BRIEF: brief said periods?:int; openapi documents
// enum:[1,3,6,12], default:1. openapi wins.

test('renew_proxy: POSTs an empty body to /v1/proxies/{id}/renew when confirmed (periods omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await renewProxy.handler(client, { id: 'proxy-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/proxies/proxy-1/renew', body: {} }]);
});

test('renew_proxy: forwards periods when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await renewProxy.handler(client, { id: 'proxy-1', periods: 12, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/proxies/proxy-1/renew', body: { periods: 12 } }]);
});

test('renew_proxy: rejects a periods value outside {1,3,6,12} before any request (deviation: brief said bare int)', async () => {
  const { client, calls } = fakeWriteClient();
  for (const periods of [2, 0, 24]) {
    const result = await renewProxy.handler(client, { id: 'proxy-1', periods, confirm: true });
    assert.equal(result.isError, true, `periods=${periods} must be rejected`);
    assert.match(textOf(result), /^Error: Invalid input for renew_proxy:/);
  }
  assert.deepEqual(calls, []);
});

test('renew_proxy: schema mirrors the periods enum and default (deviation from brief)', () => {
  const props = renewProxy.inputSchema.properties as Record<string, { enum?: number[]; default?: number }>;
  assert.deepEqual(props.periods.enum, [1, 3, 6, 12]);
  assert.equal(props.periods.default, 1);
});

// --- set_proxy_auto_renew (POST /v1/proxies/{id}/auto-renew, no gate) -----

test('set_proxy_auto_renew: POSTs {enabled} to /v1/proxies/{id}/auto-renew', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setProxyAutoRenew.handler(client, { id: 'proxy-1', enabled: false });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/proxies/proxy-1/auto-renew', body: { enabled: false } }]);
});

test('set_proxy_auto_renew: rejects a missing enabled before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setProxyAutoRenew.handler(client, { id: 'proxy-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_proxy_auto_renew:/);
  assert.deepEqual(calls, []);
});

// --- cancel_proxy (POST /v1/proxies/{id}/cancel, confirm+destr) -----------

test('cancel_proxy: POSTs an empty body to /v1/proxies/{id}/cancel when confirmed (cancel omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await cancelProxy.handler(client, { id: 'proxy-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/proxies/proxy-1/cancel', body: {} }]);
});

test('cancel_proxy: forwards cancel:false (undo) when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await cancelProxy.handler(client, { id: 'proxy-1', cancel: false, confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/proxies/proxy-1/cancel', body: { cancel: false } }]);
});

// --- set_proxy_auth_method (PATCH /v1/proxies/{id}/auth, no gate) --------

test('set_proxy_auth_method: PATCHes {method} to /v1/proxies/{id}/auth', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setProxyAuthMethod.handler(client, { id: 'proxy-1', method: 'ip' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'PATCH', path: '/v1/proxies/proxy-1/auth', body: { method: 'ip' } }]);
});

test('set_proxy_auth_method: rejects an unknown method before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setProxyAuthMethod.handler(client, { id: 'proxy-1', method: 'oauth' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_proxy_auth_method:/);
  assert.deepEqual(calls, []);
});

test('set_proxy_auth_method: schema mirrors the method enum', () => {
  const props = setProxyAuthMethod.inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(props.method.enum, ['ip', 'password', 'combined']);
});

// --- set_proxy_credentials (PUT /v1/proxies/{id}/auth/credentials, no gate) -
// Secret-hygiene precedent: same as set_service_password / reset_service_password.

test('set_proxy_credentials: PUTs {username, password} to /v1/proxies/{id}/auth/credentials', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setProxyCredentials.handler(client, { id: 'proxy-1', username: 'proxyuser', password: 'proxypass1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PUT', path: '/v1/proxies/proxy-1/auth/credentials', body: { username: 'proxyuser', password: 'proxypass1' } },
  ]);
});

test('set_proxy_credentials: description flags username/password as secrets, never echoed/logged', () => {
  assert.match(setProxyCredentials.description, /secret/i);
  assert.match(setProxyCredentials.description, /never echo/i);
});

test('set_proxy_credentials: rejects an empty username/password before any request (deviation: openapi silent on min, route enforces min(1))', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setProxyCredentials.handler(client, { id: 'proxy-1', username: '', password: 'proxypass1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_proxy_credentials:/);
  assert.deepEqual(calls, []);
});

test('set_proxy_credentials: rejects a username/password over 64 chars before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const tooLong = 'x'.repeat(65);
  const result = await setProxyCredentials.handler(client, { id: 'proxy-1', username: tooLong, password: 'proxypass1' });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

// Secret hygiene: an invalid password must never be echoed back in the zod
// validation error, even though zod's default message quotes offending
// values for some checks. If this ever regressed, the literal secret would
// leak into MCP client logs/transcripts.
test('set_proxy_credentials: an invalid password value is never echoed in the error, and no request is issued', async () => {
  const { client, calls } = fakeWriteClient();
  const badPassword = 'x'.repeat(65);
  const result = await setProxyCredentials.handler(client, { id: 'proxy-1', username: 'proxyuser', password: badPassword });
  assert.equal(result.isError, true);
  assert.ok(
    !textOf(result).includes(badPassword),
    `error text must not contain the literal password value, got: ${textOf(result)}`,
  );
  assert.deepEqual(calls, [], 'an invalid password must never reach the client');
});

test('set_proxy_credentials: schema mirrors minLength:1 (enrichment) and maxLength:64 on both fields', () => {
  const props = setProxyCredentials.inputSchema.properties as Record<string, { minLength?: number; maxLength?: number }>;
  assert.equal(props.username.minLength, 1);
  assert.equal(props.username.maxLength, 64);
  assert.equal(props.password.minLength, 1);
  assert.equal(props.password.maxLength, 64);
});

// --- add_proxy_whitelisted_ip (POST .../auth/whitelisted-ips, no gate) ----

test('add_proxy_whitelisted_ip: POSTs {ip} to /v1/proxies/{id}/auth/whitelisted-ips', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addProxyWhitelistedIp.handler(client, { id: 'proxy-1', ip: '203.0.113.5' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/proxies/proxy-1/auth/whitelisted-ips', body: { ip: '203.0.113.5' } },
  ]);
});

test('add_proxy_whitelisted_ip: accepts an IPv6 address', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addProxyWhitelistedIp.handler(client, { id: 'proxy-1', ip: '2001:db8::1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/proxies/proxy-1/auth/whitelisted-ips', body: { ip: '2001:db8::1' } },
  ]);
});

test('add_proxy_whitelisted_ip: rejects a malformed IP before any request (enrichment: route validates ipv4/ipv6)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addProxyWhitelistedIp.handler(client, { id: 'proxy-1', ip: 'not-an-ip' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_proxy_whitelisted_ip:/);
  assert.deepEqual(calls, []);
});

// --- remove_proxy_whitelisted_ip (DELETE .../whitelisted-ips/{ip}, confirm+destr) -

test('remove_proxy_whitelisted_ip: DELETEs /v1/proxies/{id}/auth/whitelisted-ips/{ip} when confirmed (no body)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await removeProxyWhitelistedIp.handler(client, { id: 'proxy-1', ip: '203.0.113.5', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/proxies/proxy-1/auth/whitelisted-ips/203.0.113.5' }]);
});

test('remove_proxy_whitelisted_ip: rejects a malformed IP before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await removeProxyWhitelistedIp.handler(client, { id: 'proxy-1', ip: 'not-an-ip', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for remove_proxy_whitelisted_ip:/);
  assert.deepEqual(calls, []);
});

test('remove_proxy_whitelisted_ip: traversal guard on the ip path segment too', async () => {
  const { client, calls } = fakeWriteClient();
  // ".." fails zod's .ip() check first (not a valid IP), so this proves the
  // zod layer already blocks it — encodeSegment is defense-in-depth.
  const result = await removeProxyWhitelistedIp.handler(client, { id: 'proxy-1', ip: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

// --- request_proxy_replacement (POST /v1/proxies/{id}/replacements, no gate) -

test('request_proxy_replacement: POSTs to /v1/proxies/{id}/replacements with no body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await requestProxyReplacement.handler(client, { id: 'proxy-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/proxies/proxy-1/replacements', body: undefined }]);
});

// --- create_proxy_request (POST /v1/proxies/{id}/proxy-requests, no gate) -
// DEVIATION FROM BRIEF: brief said rotationInterval:string; openapi/route
// restrict it to a real enum. openapi wins.

test('create_proxy_request: POSTs {countryId, proxyCount, rotationInterval} to /v1/proxies/{id}/proxy-requests', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createProxyRequest.handler(client, {
    id: 'proxy-1',
    countryId: 3,
    proxyCount: 10,
    rotationInterval: '10min',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/proxies/proxy-1/proxy-requests',
      body: { countryId: 3, proxyCount: 10, rotationInterval: '10min' },
    },
  ]);
});

test('create_proxy_request: rejects an unknown rotationInterval before any request (deviation: brief said bare string)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createProxyRequest.handler(client, {
    id: 'proxy-1',
    countryId: 3,
    proxyCount: 10,
    rotationInterval: 'every-5-minutes',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_proxy_request:/);
  assert.deepEqual(calls, []);
});

test('create_proxy_request: rejects countryId/proxyCount below 1 before any request (enrichment: route requires positive)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createProxyRequest.handler(client, {
    id: 'proxy-1',
    countryId: 0,
    proxyCount: 10,
    rotationInterval: 'high',
  });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test('create_proxy_request: schema mirrors the rotationInterval enum and countryId/proxyCount minimum:1', () => {
  const props = createProxyRequest.inputSchema.properties as Record<string, { enum?: string[]; minimum?: number }>;
  assert.deepEqual(props.rotationInterval.enum, ['all', 'high', '1min', '10min', '30min']);
  assert.equal(props.countryId.minimum, 1);
  assert.equal(props.proxyCount.minimum, 1);
});

// --- delete_proxy_request (DELETE .../proxy-requests/{reqId}, confirm+destr) -

test('delete_proxy_request: name + closed schema (confirm+destr)', () => {
  assert.equal(deleteProxyRequest.name, 'delete_proxy_request');
  assert.match(deleteProxyRequest.description, /services:write/);
  assert.deepEqual(deleteProxyRequest.inputSchema.required, ['id', 'reqId', 'confirm']);
  assert.equal(deleteProxyRequest.annotations?.destructiveHint, true);
});

test('delete_proxy_request: DELETEs /v1/proxies/{id}/proxy-requests/{reqId} when confirmed (no body)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteProxyRequest.handler(client, { id: 'proxy-1', reqId: 'req-1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/proxies/proxy-1/proxy-requests/req-1' }]);
});

test('delete_proxy_request: refuses with NO request when confirm is absent', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteProxyRequest.handler(client, { id: 'proxy-1', reqId: 'req-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /was NOT executed/);
  assert.deepEqual(calls, []);
});

test('delete_proxy_request: traversal guard on the reqId segment too', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deleteProxyRequest.handler(client, { id: 'proxy-1', reqId: '..', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid reqId value');
  assert.deepEqual(calls, []);
});
