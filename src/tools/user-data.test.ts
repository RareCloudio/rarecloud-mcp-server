// Customer userData on deploy_service, check_order and reinstall_service. The API is
// the source of truth for the rules, so these pin three things only: the value reaches
// the API byte for byte, this server applies no format check of its own, and the value
// never comes back out of this server (tool result, error text, logs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployService, checkOrder, reinstallService } from './services-write.js';
import { RareCloudClient } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

// The marker is what the leak checks look for: JSON escaping could hide the whole value.
const MARKER = 'marker-7f3a';
const VALUE = `#cloud-config\nruncmd:\n  - echo ${MARKER} ünï "quoted"\n`;

interface Case {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  path: string;
}

const CASES: Case[] = [
  { tool: deployService, args: { category: 'cloud-vm', productId: 'sku-1', confirm: true }, path: '/v1/services' },
  { tool: checkOrder, args: { category: 'cloud-vm', productId: 'sku-1' }, path: '/v1/services/preflight' },
  { tool: reinstallService, args: { service_id: 's1', imageId: 'ubuntu-24.04', confirm: true }, path: '/v1/services/s1/actions/reinstall' },
];

function userDataProperty(tool: ToolDefinition): { type: string; description: string } {
  return tool.inputSchema.properties.userData as { type: string; description: string };
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Step = { throws: Error } | { status: number; raw: string };

function envelope(data: unknown): Step {
  return { status: 200, raw: JSON.stringify({ ok: true, data }) };
}

function refusal(message: string, code = 'INVALID_PARAM', status = 400): Step {
  return { status, raw: JSON.stringify({ ok: false, error: { code, message } }) };
}

/** A real client over a scripted fetch, so the whole path this server owns is exercised. */
async function withApi<T>(
  steps: Step[],
  run: (client: RareCloudClient, calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body as string,
    });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if ('throws' in step) throw step.throws;
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      headers: { get: () => null },
      text: async () => step.raw,
    };
  }) as unknown as typeof fetch;
  try {
    return await run(new RareCloudClient({ endpoint: 'https://api.test', token: 't', sleep: async () => {} }), calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Everything written to the console or stderr while `run` is going. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ value: T; logged: string }> {
  const seen: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const originalStderr = process.stderr.write;
  const capture = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  console.debug = capture;
  process.stderr.write = ((chunk: unknown) => { seen.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const value = await run();
    return { value, logged: seen.join('\n') };
  } finally {
    Object.assign(console, original);
    process.stderr.write = originalStderr;
  }
}

function textOf(result: ToolCallResult): string {
  return result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

// --- the value reaches the API unchanged ---

for (const { tool, args, path } of CASES) {
  test(`${tool.name}: sends userData byte for byte, as plain text`, async () => {
    await withApi([envelope({ allowed: true })], async (client, calls) => {
      const result = await tool.handler(client, { ...args, userData: VALUE });
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://api.test${path}`);
      assert.equal((JSON.parse(calls[0].body) as { userData: string }).userData, VALUE);
    });
  });

  test(`${tool.name}: sends no userData key when it is not given`, async () => {
    await withApi([envelope({ allowed: true })], async (client, calls) => {
      await tool.handler(client, args);
      assert.equal('userData' in (JSON.parse(calls[0].body) as object), false);
    });
  });

  // --- no client-side format check: the API decides ---

  for (const [label, value] of [
    ['an empty string', ''],
    ['a value with the wrong first line', 'runcmd:\n  - echo hi\n'],
    ['a value over 32 KiB', `#!/bin/sh\n${'x'.repeat(40_000)}`],
  ] as const) {
    test(`${tool.name}: ${label} goes to the API, which decides`, async () => {
      await withApi([envelope({ allowed: true })], async (client, calls) => {
        const result = await tool.handler(client, { ...args, userData: value });
        assert.equal(result.isError, undefined);
        assert.equal((JSON.parse(calls[0].body) as { userData: string }).userData, value);
      });
    });
  }

  test(`${tool.name}: the advertised field is a plain string with no format rule of its own`, () => {
    const property = userDataProperty(tool);
    assert.deepEqual(Object.keys(property).sort(), ['description', 'type']);
    assert.equal(property.type, 'string');
  });

  // --- the value never comes back out ---

  test(`${tool.name}: an API refusal is passed on and carries no part of the value`, async () => {
    const message = 'userData must start with a #cloud-config line or a #! script line.';
    await withApi([refusal(message)], async (client) => {
      const { value: result, logged } = await captureLogs(() => tool.handler(client, { ...args, userData: VALUE }));
      assert.equal(result.isError, true);
      assert.equal(textOf(result), `Error: [INVALID_PARAM] ${message}`);
      assert.equal(logged.includes(MARKER), false);
    });
  });

  test(`${tool.name}: a success result and the logs do not repeat the value`, async () => {
    await withApi([envelope({ id: 'new', allowed: true })], async (client, calls) => {
      const { value: result, logged } = await captureLogs(() => tool.handler(client, { ...args, userData: VALUE }));
      assert.equal(calls[0].body.includes(MARKER), true);
      assert.equal(textOf(result).includes(MARKER), false);
      assert.equal(logged.includes(MARKER), false);
    });
  });

  for (const [label, step] of [
    ['a dropped connection', { throws: new Error('socket hang up') }],
    ['a gateway page', { status: 502, raw: '<html>bad gateway</html>' }],
    ['a body-size refusal', refusal('Request body too large.', 'PAYLOAD_TOO_LARGE', 413)],
  ] as Array<[string, Step]>) {
    test(`${tool.name}: ${label} does not put the value in the error or the logs`, async () => {
      await withApi([step], async (client) => {
        const { value: result, logged } = await captureLogs(() => tool.handler(client, { ...args, userData: VALUE }));
        assert.equal(result.isError, true);
        assert.equal(textOf(result).includes(MARKER), false);
        assert.equal(logged.includes(MARKER), false);
      });
    });
  }

  for (const [label, badInput] of [
    ['an object', { userData: { note: MARKER } }],
    ['an array', { userData: [MARKER] }],
    ['the wrong key', { user_data: MARKER }],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`${tool.name}: ${label} is refused locally without repeating what was sent`, async () => {
      await withApi([envelope({})], async (client, calls) => {
        const { value: result, logged } = await captureLogs(() => tool.handler(client, { ...args, ...badInput }));
        assert.equal(result.isError, true);
        assert.match(textOf(result), new RegExp(`^Error: Invalid input for ${tool.name}: `));
        assert.equal(textOf(result).includes(MARKER), false);
        assert.equal(logged.includes(MARKER), false);
        assert.equal(calls.length, 0);
      });
    });
  }

  // --- what the agent is told ---

  test(`${tool.name}: the field description states the rules`, () => {
    const { description } = userDataProperty(tool);
    assert.match(description, /at first boot/);
    assert.match(description, /cloud VMs? only|cloud-vm only/i);
    assert.match(description, /first line must start with `#cloud-config` or `#!`/i);
    assert.match(description, /32 KiB/);
    assert.match(description, /any local process inside the VM can read it/);
    assert.match(description, /Do not put secrets in it/);
    assert.match(description, /snapshot needs cloud-init/);
    assert.match(description, /not stored/);
    assert.match(description, /reinstall/);
    assert.match(description, /send it again/);
  });
}

// --- additive: nothing new is required ---

test('userData is optional everywhere: the required lists are unchanged', () => {
  assert.deepEqual(deployService.inputSchema.required, ['confirm']);
  assert.deepEqual(checkOrder.inputSchema.required, []);
  assert.deepEqual(reinstallService.inputSchema.required, ['service_id', 'imageId', 'confirm']);
});

test('deploy_service and check_order advertise one and the same field', () => {
  assert.deepEqual(userDataProperty(checkOrder), userDataProperty(deployService));
});

// --- the confirm gate runs first, and does not quote the args ---

for (const tool of [deployService, reinstallService]) {
  const args = tool === deployService ? { productId: 'sku-1' } : { service_id: 's1', imageId: 'ubuntu-24.04' };
  test(`${tool.name}: without confirm it refuses, sends nothing and does not quote the value`, async () => {
    await withApi([envelope({})], async (client, calls) => {
      const result = await tool.handler(client, { ...args, userData: VALUE });
      assert.equal(result.isError, true);
      assert.equal(textOf(result).includes(MARKER), false);
      assert.equal(calls.length, 0);
    });
  });
}

// --- a safe retry resends the same request ---

for (const { tool, args } of CASES.filter((c) => c.tool !== checkOrder)) {
  test(`${tool.name}: the retry after a dropped connection carries the same userData and key`, async () => {
    await withApi([{ throws: new Error('socket hang up') }, envelope({ id: 'new' })], async (client, calls) => {
      const result = await tool.handler(client, { ...args, userData: VALUE });
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].body, calls[0].body);
      assert.equal(calls[1].headers['Idempotency-Key'], calls[0].headers['Idempotency-Key']);
    });
  });
}

// --- another product or a legacy VPS: the API refuses, and the agent reads why ---

test('deploy_service: userData on another product goes to the API and its refusal is shown', async () => {
  const message = 'userData is only available on cloud VMs, not on proxy.';
  await withApi([refusal(message)], async (client, calls) => {
    const result = await deployService.handler(client, { category: 'proxy', productId: 'sku-1', userData: VALUE, confirm: true });
    assert.equal(calls.length, 1);
    assert.equal(textOf(result), `Error: [INVALID_PARAM] ${message}`);
  });
});

test('reinstall_service: userData on a legacy VPS goes to the API and its refusal is shown', async () => {
  const message = 'userData is only available on cloud VMs, not on a legacy VPS.';
  await withApi([refusal(message)], async (client, calls) => {
    const result = await reinstallService.handler(client, { service_id: '123', imageId: 'debian-12', userData: VALUE, confirm: true });
    assert.equal(calls.length, 1);
    assert.equal(textOf(result), `Error: [INVALID_PARAM] ${message}`);
  });
});

// --- reinstall has rules of its own ---

test('reinstall_service: the field description covers a snapshot of the same VM', () => {
  const { description } = userDataProperty(reinstallService);
  assert.match(description, /snapshot of this same VM is refused/);
  assert.match(description, /create a new VM from that snapshot/);
  assert.match(description, /or the VM gets none/);
});

test('reinstall_service: the tool description says an earlier userData is not reused', () => {
  assert.match(reinstallService.description, /userData/);
  assert.match(reinstallService.description, /not kept from an earlier deploy or reinstall/);
});
