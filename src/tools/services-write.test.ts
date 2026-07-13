// Unit tests for the first Parity Phase B write tool, set_service_hostname.
// A fake client records method+path+body (no network); we assert the closed
// schema, path encoding, body shape, the traversal guard, zod rejection, and
// the uniform APIError -> errorResult mapping the factory provides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setServiceHostname,
  deployService,
  destroyService,
  resizeService,
  upgradeService,
  renewService,
  cancelService,
  setServiceAutorenew,
  createServiceBackup,
  mountServiceIso,
  unmountServiceIso,
  setServicePassword,
  startService,
  stopService,
  rebootService,
  reinstallService,
  resetServicePassword,
  addServiceSshKey,
  addServiceSshKeyToLibrary,
  applyServiceSshKeyLibrary,
} from './services-write.js';
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

test('set_service_hostname: name + closed schema (no confirm — plain write)', () => {
  assert.equal(setServiceHostname.name, 'set_service_hostname');
  assert.ok(setServiceHostname.description.trim().length > 0);
  assert.deepEqual(setServiceHostname.inputSchema.required, ['service_id', 'hostname']);
  assert.equal(setServiceHostname.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(setServiceHostname.inputSchema.properties), ['service_id', 'hostname']);
  // A non-gated write must NOT advertise confirm, and carries no destructiveHint.
  assert.ok(!('confirm' in setServiceHostname.inputSchema.properties));
  assert.equal(setServiceHostname.annotations, undefined);
});

test('set_service_hostname: encodes service_id into the path and POSTs the hostname body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServiceHostname.handler(client, { service_id: 'svc 1/2', hostname: 'h' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/svc%201%2F2/hostname', body: { hostname: 'h' } },
  ]);
});

test('set_service_hostname: a ".." service_id is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServiceHostname.handler(client, { service_id: '..', hostname: 'h' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: Invalid service_id value');
  assert.deepEqual(calls, [], 'no request may reach the client for a ".." service_id');
});

test('set_service_hostname: missing hostname is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServiceHostname.handler(client, { service_id: 'srv-1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_service_hostname:/);
  assert.deepEqual(calls, [], 'a zod-rejected call must not reach the client');
});

test('set_service_hostname: APIError maps to errorResult with [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await setServiceHostname.handler(client, { service_id: 'srv-1', hostname: 'h' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});

// ---------------------------------------------------------------------------
// Task 2 — services deploy + lifecycle + money-spend (11 tools).
// ---------------------------------------------------------------------------

// Every new tool, with its gate flags and a set of minimal valid DOMAIN args
// (excluding service_id and the factory-owned confirm). Drives the shared
// schema / gate / traversal / error assertions below.
type NewToolCase = {
  tool: ToolDefinition;
  gated: boolean; // advertises confirm
  destructive: boolean; // advertises annotations.destructiveHint
  hasServiceId: boolean; // has a service_id path segment (deploy does not)
  args: Record<string, unknown>;
};

const NEW_TOOLS: Record<string, NewToolCase> = {
  deploy_service: { tool: deployService, gated: true, destructive: false, hasServiceId: false, args: { productId: 'sku-1' } },
  destroy_service: { tool: destroyService, gated: true, destructive: true, hasServiceId: true, args: {} },
  resize_service: { tool: resizeService, gated: true, destructive: false, hasServiceId: true, args: { flavor: 'c-2vcpu-4gb' } },
  upgrade_service: { tool: upgradeService, gated: true, destructive: false, hasServiceId: true, args: { newProductId: 'p2', cycle: 'monthly' } },
  renew_service: { tool: renewService, gated: true, destructive: false, hasServiceId: true, args: {} },
  cancel_service: { tool: cancelService, gated: true, destructive: true, hasServiceId: true, args: {} },
  set_service_autorenew: { tool: setServiceAutorenew, gated: false, destructive: false, hasServiceId: true, args: { enabled: true } },
  create_service_backup: { tool: createServiceBackup, gated: false, destructive: false, hasServiceId: true, args: {} },
  mount_service_iso: { tool: mountServiceIso, gated: false, destructive: false, hasServiceId: true, args: { iso_url: 'https://ex/a.iso' } },
  unmount_service_iso: { tool: unmountServiceIso, gated: false, destructive: false, hasServiceId: true, args: {} },
  set_service_password: { tool: setServicePassword, gated: true, destructive: true, hasServiceId: true, args: { password: 'supersecret1' } },
};

test('task2 registry: each tool has its expected name, closed schema, and services:write in the description', () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.match(c.tool.description, /services:write/, `${name} description must name the scope`);
  }
});

test('task2 gates: confirm advertised iff gated; destructiveHint iff destructive', () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    const hasConfirm = 'confirm' in c.tool.inputSchema.properties;
    assert.equal(hasConfirm, c.gated, `${name}: confirm-in-schema must match gated=${c.gated}`);
    if (c.gated) {
      assert.ok(
        (c.tool.inputSchema.required ?? []).includes('confirm'),
        `${name}: gated tool must require confirm`,
      );
    }
    assert.equal(
      c.tool.annotations?.destructiveHint ?? false,
      c.destructive,
      `${name}: destructiveHint must match destructive=${c.destructive}`,
    );
  }
});

test('task2 required service_id: tools with a path segment require service_id; deploy does not', () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    const required = c.tool.inputSchema.required ?? [];
    if (c.hasServiceId) {
      assert.ok(required.includes('service_id'), `${name} must require service_id`);
    } else {
      assert.ok(!required.includes('service_id'), `${name} must not require service_id`);
    }
  }
});

test('task2 confirm gate: gated tools refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const base = c.hasServiceId ? { service_id: 'svc-1' } : {};
    const result = await c.tool.handler(client, { ...base, ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('task2 traversal guard: a ".." service_id is rejected before any request', async () => {
  for (const [name, c] of Object.entries(NEW_TOOLS)) {
    if (!c.hasServiceId) continue;
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { service_id: '..', ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid service_id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

test('task2 APIError mapping: a representative gated tool maps [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await resizeService.handler(client, {
    service_id: 'srv-1',
    flavor: 'c-2vcpu-4gb',
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});

// --- deploy_service (polymorphic, no path segment) ---

test('deploy_service: POSTs the whole validated body to /v1/services (confirm stripped from body)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deployService.handler(client, {
    category: 'cloud-vm',
    productId: 'sku-1',
    region: 'ro-buc',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services', body: { category: 'cloud-vm', productId: 'sku-1', region: 'ro-buc' } },
  ]);
});

test('deploy_service: the plan alias satisfies the productId||plan requirement', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deployService.handler(client, { plan: 'sku-2', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services', body: { plan: 'sku-2' } }]);
});

test('deploy_service: neither productId nor plan is rejected before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deployService.handler(client, { region: 'ro-buc', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for deploy_service:/);
  assert.match(textOf(result), /productId \(or its alias plan\) is required/);
  assert.deepEqual(calls, [], 'a deploy with no productId/plan must not reach the client');
});

test('deploy_service: an unknown property is rejected by the strict schema', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await deployService.handler(client, { productId: 'sku-1', bogus: 'x', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for deploy_service:/);
  assert.deepEqual(calls, []);
});

// --- destroy_service (DELETE, no body) ---

test('destroy_service: DELETEs /v1/services/{id} with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await destroyService.handler(client, { service_id: 'svc/9', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/services/svc%2F9' }]);
});

// --- resize_service ---

test('resize_service: POSTs {flavor} to /resize when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await resizeService.handler(client, { service_id: 's1', flavor: 'c-4vcpu-8gb', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/resize', body: { flavor: 'c-4vcpu-8gb' } },
  ]);
});

// --- upgrade_service (must forward confirm:true in the body) ---

test('upgrade_service: POSTs {newProductId,cycle,confirm:true} to /upgrade', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await upgradeService.handler(client, {
    service_id: 's1',
    newProductId: 'p2',
    cycle: 'annually',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/upgrade', body: { newProductId: 'p2', cycle: 'annually', confirm: true } },
  ]);
});

// --- renew_service (POST, no body) ---

test('renew_service: POSTs /renew with no body when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await renewService.handler(client, { service_id: 's1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/renew', body: undefined }]);
});

// --- cancel_service (optional type/reason; omit undefined) ---

test('cancel_service: forwards type + reason when provided', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await cancelService.handler(client, {
    service_id: 's1',
    type: 'immediate',
    reason: 'no longer needed',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/cancel', body: { type: 'immediate', reason: 'no longer needed' } },
  ]);
});

test('cancel_service: omits undefined type/reason (empty body)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await cancelService.handler(client, { service_id: 's1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/cancel', body: {} }]);
});

test('cancel_service: rejects an out-of-enum type before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await cancelService.handler(client, { service_id: 's1', type: 'end-of-term', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for cancel_service:/);
  assert.deepEqual(calls, []);
});

// --- set_service_autorenew (PUT, no confirm) ---

test('set_service_autorenew: PUTs {enabled} with no confirm gate', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServiceAutorenew.handler(client, { service_id: 's1', enabled: false });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PUT', path: '/v1/services/s1/autorenew', body: { enabled: false } },
  ]);
});

// --- create_service_backup (POST, no body, no confirm) ---

test('create_service_backup: POSTs /backups with no body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createServiceBackup.handler(client, { service_id: 's1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/backups', body: undefined }]);
});

// --- mount_service_iso (PUT {iso_url}) ---

test('mount_service_iso: PUTs {iso_url} to /iso', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await mountServiceIso.handler(client, { service_id: 's1', iso_url: 'https://ex/a.iso' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'PUT', path: '/v1/services/s1/iso', body: { iso_url: 'https://ex/a.iso' } },
  ]);
});

// --- unmount_service_iso (DELETE, no body, no confirm) ---

test('unmount_service_iso: DELETEs /iso with no body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await unmountServiceIso.handler(client, { service_id: 's1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/v1/services/s1/iso' }]);
});

// --- set_service_password (secret; confirm+destr) ---

test('set_service_password: POSTs {password} to /password when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServicePassword.handler(client, { service_id: 's1', password: 'supersecret1', confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/password', body: { password: 'supersecret1' } },
  ]);
});

test('set_service_password: rejects a short password before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await setServicePassword.handler(client, { service_id: 's1', password: 'short', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for set_service_password:/);
  assert.deepEqual(calls, []);
});

// Secret hygiene: an invalid password must never be echoed back in the zod
// validation error, even though zod's default message quotes offending
// values for some checks. If this ever regressed, the literal secret would
// leak into MCP client logs/transcripts.
test('set_service_password: an invalid password value is never echoed in the error, and no request is issued', async () => {
  const { client, calls } = fakeWriteClient();
  const badPassword = 'hunter1';
  const result = await setServicePassword.handler(client, {
    service_id: 's1',
    password: badPassword,
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.ok(
    !textOf(result).includes(badPassword),
    `error text must not contain the literal password value, got: ${textOf(result)}`,
  );
  assert.deepEqual(calls, [], 'an invalid password must never reach the client');
});

// ---------------------------------------------------------------------------
// Task 3 — service actions (start/stop/reboot/reinstall/reset-password) +
// ssh-keys (8 tools).
//
// DEVIATION FROM BRIEF (verified against console openapi.json AND the actual
// route handler in api/src/routes/v1-services.ts, both of which AGREE with
// each other and DISAGREE with the task-3 brief — openapi/source win per the
// task's own tie-break rule):
//   - reinstall_service: the live endpoint requires `imageId` in the body for
//     BOTH a cloud VM (Nova UUID id) AND a legacy VPS (numeric id) — an empty
//     body always 400s. It is NOT legacy-VPS-only either: the route's
//     UUID_RE branch calls cloudServices.reinstallCloudVm. The brief's stale
//     "cloud-vm rebuild is unsupported by this endpoint" wording is copied
//     from an outdated code comment (v1-services.ts line 388) that predates
//     the cloud-VM branch actually implemented a few lines below it.
//   - reset_service_password: the live endpoint requires a caller-chosen
//     `password` in the body (min 8 chars) — it does NOT auto-generate a
//     random password. It is CLOUD-VM-ONLY (a legacy numeric id is rejected
//     with INVALID_PARAM); set_service_password's own endpoint
//     (/services/{id}/password) is the legacy-VPS twin.
// Both tools therefore carry a body, matching the real API contract instead
// of the brief's "no body" / "random password" description.
// ---------------------------------------------------------------------------

type Task3ToolCase = {
  tool: ToolDefinition;
  gated: boolean;
  destructive: boolean;
  args: Record<string, unknown>;
};

const TASK3_TOOLS: Record<string, Task3ToolCase> = {
  start_service: { tool: startService, gated: false, destructive: false, args: {} },
  stop_service: { tool: stopService, gated: false, destructive: false, args: {} },
  reboot_service: { tool: rebootService, gated: false, destructive: false, args: {} },
  reinstall_service: { tool: reinstallService, gated: true, destructive: true, args: { imageId: 'ubuntu-24.04' } },
  reset_service_password: { tool: resetServicePassword, gated: true, destructive: true, args: { password: 'supersecret1' } },
  add_service_ssh_key: { tool: addServiceSshKey, gated: false, destructive: false, args: { public_key: 'ssh-ed25519 AAAAtest' } },
  add_service_ssh_key_to_library: {
    tool: addServiceSshKeyToLibrary,
    gated: false,
    destructive: false,
    args: { name: 'laptop', key: 'ssh-ed25519 AAAAtest' },
  },
  apply_service_ssh_key_library: { tool: applyServiceSshKeyLibrary, gated: false, destructive: false, args: {} },
};

test('task3 registry: each tool has its expected name, closed schema, requires service_id, services:write in description', () => {
  for (const [name, c] of Object.entries(TASK3_TOOLS)) {
    assert.equal(c.tool.name, name);
    assert.equal(c.tool.inputSchema.additionalProperties, false, `${name} must have a closed schema`);
    assert.equal(c.tool.inputSchema.type, 'object');
    assert.match(c.tool.description, /services:write/, `${name} description must name the scope`);
    assert.ok(
      (c.tool.inputSchema.required ?? []).includes('service_id'),
      `${name} must require service_id`,
    );
  }
});

test('task3 gates: confirm advertised iff gated; destructiveHint iff destructive', () => {
  for (const [name, c] of Object.entries(TASK3_TOOLS)) {
    const hasConfirm = 'confirm' in c.tool.inputSchema.properties;
    assert.equal(hasConfirm, c.gated, `${name}: confirm-in-schema must match gated=${c.gated}`);
    if (c.gated) {
      assert.ok(
        (c.tool.inputSchema.required ?? []).includes('confirm'),
        `${name}: gated tool must require confirm`,
      );
    }
    assert.equal(
      c.tool.annotations?.destructiveHint ?? false,
      c.destructive,
      `${name}: destructiveHint must match destructive=${c.destructive}`,
    );
  }
});

test('task3 confirm gate: gated tools (reinstall, reset-password) refuse with NO request when confirm is absent', async () => {
  for (const [name, c] of Object.entries(TASK3_TOOLS)) {
    if (!c.gated) continue;
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { service_id: 'svc-1', ...c.args });
    assert.equal(result.isError, true, `${name} must refuse without confirm`);
    assert.match(textOf(result), /was NOT executed/, `${name} refusal message`);
    assert.deepEqual(calls, [], `${name} must issue no request without confirm`);
  }
});

test('task3 traversal guard: a ".." service_id is rejected before any request', async () => {
  for (const [name, c] of Object.entries(TASK3_TOOLS)) {
    const { client, calls } = fakeWriteClient();
    const confirmArg = c.gated ? { confirm: true } : {};
    const result = await c.tool.handler(client, { service_id: '..', ...c.args, ...confirmArg });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid service_id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

test('task3 APIError mapping: a representative tool maps [CODE] message', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'services:write scope required' });
  });
  const result = await startService.handler(client, { service_id: 'srv-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] services:write scope required');
});

// --- start / stop / reboot (POST, no body, no confirm, distinct literal suffixes) ---

test('start_service: POSTs /actions/start with no body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await startService.handler(client, { service_id: 's1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/actions/start', body: undefined }]);
});

test('stop_service: POSTs /actions/stop with no body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await stopService.handler(client, { service_id: 's1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/actions/stop', body: undefined }]);
});

test('reboot_service: POSTs /actions/reboot with no body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await rebootService.handler(client, { service_id: 's1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/actions/reboot', body: undefined }]);
});

// --- reinstall_service (confirm + destructiveHint; requires imageId) ---

test('reinstall_service: POSTs {imageId} to /actions/reinstall when confirmed (optional fields omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await reinstallService.handler(client, {
    service_id: 's1',
    imageId: 'ubuntu-24.04',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/actions/reinstall', body: { imageId: 'ubuntu-24.04' } },
  ]);
});

test('reinstall_service: forwards optional password + sshPublicKey when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await reinstallService.handler(client, {
    service_id: 's1',
    imageId: 'ubuntu-24.04',
    password: 'supersecret1',
    sshPublicKey: 'ssh-ed25519 AAAAtest',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/services/s1/actions/reinstall',
      body: { imageId: 'ubuntu-24.04', password: 'supersecret1', sshPublicKey: 'ssh-ed25519 AAAAtest' },
    },
  ]);
});

test('reinstall_service: missing imageId is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await reinstallService.handler(client, { service_id: 's1', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for reinstall_service:/);
  assert.deepEqual(calls, []);
});

// Guard: the response can carry a one-time consolePassword root credential
// (cloud VM only, when no password was supplied) — the description must carry
// the same treat-as-secret guidance as the other credential-returning tools
// (get_proxy_auth, get_cluster_kubeconfig).
test('reinstall_service: description flags the one-time consolePassword as a secret', () => {
  assert.match(reinstallService.description, /secret/i);
  assert.match(reinstallService.description, /consolePassword/);
  assert.match(reinstallService.description, /do not echo/i);
  assert.match(reinstallService.description, /unless the user explicitly asks/i);
});

// --- reset_service_password (confirm + destructiveHint; requires password) ---

test('reset_service_password: POSTs {password} to /actions/reset-password when confirmed', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await resetServicePassword.handler(client, {
    service_id: 's1',
    password: 'supersecret1',
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/actions/reset-password', body: { password: 'supersecret1' } },
  ]);
});

test('reset_service_password: rejects a short password before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await resetServicePassword.handler(client, { service_id: 's1', password: 'short', confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for reset_service_password:/);
  assert.deepEqual(calls, []);
});

test('reset_service_password: an invalid password value is never echoed in the error, and no request is issued', async () => {
  const { client, calls } = fakeWriteClient();
  const badPassword = 'hunter1';
  const result = await resetServicePassword.handler(client, {
    service_id: 's1',
    password: badPassword,
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.ok(
    !textOf(result).includes(badPassword),
    `error text must not contain the literal password value, got: ${textOf(result)}`,
  );
  assert.deepEqual(calls, [], 'an invalid password must never reach the client');
});

// --- add_service_ssh_key (POST {public_key, name?, id?}, no confirm) ---

test('add_service_ssh_key: POSTs {public_key} to /ssh-keys (optional name/id omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addServiceSshKey.handler(client, { service_id: 's1', public_key: 'ssh-ed25519 AAAAtest' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/ssh-keys', body: { public_key: 'ssh-ed25519 AAAAtest' } },
  ]);
});

test('add_service_ssh_key: forwards optional name + id when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addServiceSshKey.handler(client, {
    service_id: 's1',
    public_key: 'ssh-ed25519 AAAAtest',
    name: 'laptop',
    id: 'key-1',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/services/s1/ssh-keys',
      body: { public_key: 'ssh-ed25519 AAAAtest', name: 'laptop', id: 'key-1' },
    },
  ]);
});

test('add_service_ssh_key: missing public_key is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addServiceSshKey.handler(client, { service_id: 's1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_service_ssh_key:/);
  assert.deepEqual(calls, []);
});

// --- add_service_ssh_key_to_library (POST {name, key}, no confirm) ---

test('add_service_ssh_key_to_library: POSTs {name, key} to /ssh-keys/library', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addServiceSshKeyToLibrary.handler(client, {
    service_id: 's1',
    name: 'laptop',
    key: 'ssh-ed25519 AAAAtest',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/ssh-keys/library', body: { name: 'laptop', key: 'ssh-ed25519 AAAAtest' } },
  ]);
});

test('add_service_ssh_key_to_library: missing name/key is rejected by zod before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await addServiceSshKeyToLibrary.handler(client, { service_id: 's1' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for add_service_ssh_key_to_library:/);
  assert.deepEqual(calls, []);
});

// --- apply_service_ssh_key_library (POST {keyIds?}, no confirm) ---

test('apply_service_ssh_key_library: POSTs {keyIds} to /ssh-keys/library/apply when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await applyServiceSshKeyLibrary.handler(client, { service_id: 's1', keyIds: ['k1', 'k2'] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/v1/services/s1/ssh-keys/library/apply', body: { keyIds: ['k1', 'k2'] } },
  ]);
});

test('apply_service_ssh_key_library: omits undefined keyIds (empty body) when not supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await applyServiceSshKeyLibrary.handler(client, { service_id: 's1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/services/s1/ssh-keys/library/apply', body: {} }]);
});
