// Unit tests for the AI Sandboxes tools: list / get / templates, create (spends,
// idempotent, env values never echoed), delete (destructive), run code, run a
// shell command, read and write a file, and the run-mode logs. A fake client
// records method + path + body (no network); we assert paths, query strings,
// exact body shapes (omit-undefined optionals), closed schemas, the confirm
// gate, env redaction, the logs 503/404 wording, and the traversal guard on the
// sandbox id. Shapes mirror api/src/routes/v1-sandboxes.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listSandboxes,
  getSandbox,
  listSandboxTemplates,
  listSandboxSizes,
  readSandboxFile,
  getSandboxLogs,
} from './sandboxes.js';
import {
  createSandbox,
  deleteSandbox,
  runSandboxCode,
  runSandboxCommand,
  writeSandboxFile,
} from './sandboxes-write.js';
import { APIError, type RareCloudClient, type PostOptions } from '../client.js';
import type { ToolCallResult, ToolDefinition } from './types.js';

type Call = { method: string; path: string; body?: unknown; idempotent?: boolean };

function fakeClient(
  impl: (m: string, p: string, b?: unknown) => unknown = () => ({ ok: true }),
): { client: RareCloudClient; calls: Call[] } {
  const calls: Call[] = [];
  const withBody = (method: string) => async (path: string, body?: unknown, opts?: PostOptions) => {
    const call: Call = body === undefined ? { method, path } : { method, path, body };
    if (opts?.idempotent) call.idempotent = true;
    calls.push(call);
    return impl(method, path, body);
  };
  const client = {
    get: withBody('GET'),
    getText: withBody('GET_TEXT'),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    delete: withBody('DELETE'),
  } as unknown as RareCloudClient;
  return { client, calls };
}

function textOf(result: ToolCallResult, i = 0): string {
  const block = result.content[i];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

const SBX = 'sbx-0a1b2c3d';

// --- reads ------------------------------------------------------------------

const READS: Array<[ToolDefinition, string, Record<string, unknown>, string]> = [
  [listSandboxes, 'list_sandboxes', {}, '/v1/sandboxes'],
  [listSandboxTemplates, 'list_sandbox_templates', {}, '/v1/sandboxes/templates'],
  [listSandboxSizes, 'list_sandbox_sizes', {}, '/v1/sandboxes/sizes'],
  [getSandbox, 'get_sandbox', { id: SBX }, `/v1/sandboxes/${SBX}`],
  [readSandboxFile, 'read_sandbox_file', { id: SBX, path: '/home/user/out.txt' }, `/v1/sandboxes/${SBX}/files?path=%2Fhome%2Fuser%2Fout.txt`],
  [readSandboxFile, 'read_sandbox_file', { id: SBX, path: '/tmp/a b&c.txt' }, `/v1/sandboxes/${SBX}/files?path=%2Ftmp%2Fa+b%26c.txt`],
];

for (const [tool, name, args, path] of READS) {
  test(`sandbox read: ${name} ${JSON.stringify(args)} GETs ${path}`, async () => {
    assert.equal(tool.name, name);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} is a read`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} closed schema`);
    assert.ok(!tool.description.includes(':write'), `${name} must not name a write scope`);
    assert.match(tool.description, /services:read/, `${name} names its scope`);
    const { client, calls } = fakeClient(() => ({ data: name }));
    const result = await tool.handler(client, args);
    assert.deepEqual(calls, [{ method: 'GET', path }]);
    assert.deepEqual(JSON.parse(textOf(result)), { data: name });
  });
}

test('sandbox read: id reads name list_sandboxes and reject traversal with no request', async () => {
  for (const [t, rest] of [
    [getSandbox, {}],
    [readSandboxFile, { path: '/x' }],
    [getSandboxLogs, {}],
  ] as Array<[ToolDefinition, Record<string, unknown>]>) {
    assert.ok(t.inputSchema.required?.includes('id'), t.name);
    assert.match((t.inputSchema.properties.id as { description: string }).description, /list_sandboxes/, t.name);
    for (const bad of ['..', '.', '']) {
      const { client, calls } = fakeClient();
      const result = await t.handler(client, { ...rest, id: bad });
      assert.equal(result.isError, true, `${t.name} must refuse id=${JSON.stringify(bad)}`);
      assert.deepEqual(calls, [], `${t.name} must make no request for id=${JSON.stringify(bad)}`);
    }
  }
});

test('read_sandbox_file: path must be absolute; refused locally with no request', async () => {
  assert.deepEqual(readSandboxFile.inputSchema.required, ['id', 'path']);
  for (const bad of ['relative.txt', '', undefined]) {
    const { client, calls } = fakeClient();
    const result = await readSandboxFile.handler(client, { id: SBX, path: bad });
    assert.equal(result.isError, true, `path=${JSON.stringify(bad)}`);
    assert.deepEqual(calls, []);
  }
  assert.match(readSandboxFile.description, /base64/);
});

test('sandbox read: an APIError becomes an error result', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'BACKEND_UNAVAILABLE', message: 'AI Sandboxes are not available yet.' }, { status: 503 });
  });
  const result = await listSandboxes.handler(client, {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /AI Sandboxes are not available yet/);
});

test('list_sandbox_templates: description says it lists size and hourly price', () => {
  assert.match(listSandboxTemplates.description, /price/);
  assert.match(listSandboxTemplates.description, /create_sandbox/);
});

test('list_sandbox_sizes: returns sizes and the custom block as the API sent them', async () => {
  const payload = {
    sizes: [
      { slug: 'xs', label: 'XS', vcpu: 1, ramGb: 1, diskGb: 3, hourlyCents: 5.2, accountCurrency: 'EUR', accountHourlyCents: 5.2, available: true, default: false },
      { slug: 'l', label: 'L', vcpu: 2, ramGb: 8, diskGb: 3, hourlyCents: 17.6, accountCurrency: 'EUR', accountHourlyCents: 17.6, available: false, default: false },
    ],
    defaultSize: 's',
    custom: { vcpuMin: 1, vcpuMax: 8, ramGbMin: 1, ramGbMax: 32, ramGbPerVcpuMin: 1, ramGbPerVcpuMax: 8, vcpuCentsPerHour: 4, ramGbCentsPerHour: 1.2, maxAvailableVcpu: 1, maxAvailableRamGb: 2 },
  };
  const { client, calls } = fakeClient(() => payload);
  const result = await listSandboxSizes.handler(client, {});
  assert.deepEqual(calls, [{ method: 'GET', path: '/v1/sandboxes/sizes' }]);
  assert.deepEqual(JSON.parse(textOf(result)), payload);
});

test('list_sandbox_sizes: description covers availability, the custom bounds, price and create_sandbox', () => {
  const d = listSandboxSizes.description;
  for (const word of ['available', 'custom', 'maxAvailableVcpu', 'maxAvailableRamGb', 'hourlyCents', 'create_sandbox', 'size_unavailable']) {
    assert.ok(d.includes(word), `description names ${word}`);
  }
});

// --- logs ---------------------------------------------------------------------

test('get_sandbox_logs: GETs plain text /logs, with tail only when given, returned verbatim', async () => {
  assert.equal(getSandboxLogs.annotations.readOnlyHint, true);
  assert.equal(getSandboxLogs.inputSchema.additionalProperties, false);
  const { client, calls } = fakeClient(() => 'line 1\nline 2\n');
  const r1 = await getSandboxLogs.handler(client, { id: SBX });
  const r2 = await getSandboxLogs.handler(client, { id: SBX, tail: 50 });
  assert.deepEqual(calls, [
    { method: 'GET_TEXT', path: `/v1/sandboxes/${SBX}/logs` },
    { method: 'GET_TEXT', path: `/v1/sandboxes/${SBX}/logs?tail=50` },
  ]);
  assert.equal(textOf(r1), 'line 1\nline 2\n');
  assert.equal(r1.isError, undefined);
  assert.equal(textOf(r2), 'line 1\nline 2\n');
  assert.deepEqual(
    { ...(getSandboxLogs.inputSchema.properties.tail as Record<string, unknown>), description: undefined },
    { type: 'integer', minimum: 1, maximum: 5000, description: undefined },
  );
});

test('get_sandbox_logs: a tail outside 1-5000 is refused with no request', async () => {
  for (const bad of [0, 5001, 1.5, '10']) {
    const { client, calls } = fakeClient(() => '');
    const result = await getSandboxLogs.handler(client, { id: SBX, tail: bad });
    assert.equal(result.isError, true, `tail=${JSON.stringify(bad)}`);
    assert.deepEqual(calls, []);
  }
});

test('get_sandbox_logs: empty output says there are no lines yet (not an error)', async () => {
  const { client } = fakeClient(() => '');
  const result = await getSandboxLogs.handler(client, { id: SBX });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /no log lines/i);
});

test('get_sandbox_logs: a 503 passes the API message through and says logs are not available yet', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'BACKEND_UNAVAILABLE', message: 'Logs are not available yet.' }, { status: 503 });
  });
  const result = await getSandboxLogs.handler(client, { id: SBX });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /\[BACKEND_UNAVAILABLE\] Logs are not available yet\./);
  assert.match(text, /not available/i);
  assert.match(text, /retry later/i);
});

test('get_sandbox_logs: a 404 says the logs are gone', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'Sandbox not found.' }, { status: 404 });
  });
  const result = await getSandboxLogs.handler(client, { id: SBX });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /Sandbox not found/);
  assert.match(text, /gone/);
  assert.match(text, /24 hours/);
});

test('get_sandbox_logs: any other error is passed through unchanged', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'INVALID_PARAM', message: 'bad tail' }, { status: 400 });
  });
  const result = await getSandboxLogs.handler(client, { id: SBX });
  assert.equal(textOf(result), 'Error: [INVALID_PARAM] bad tail');
});

// --- writes: shared expectations ----------------------------------------------

const WRITES: Array<[ToolDefinition, string, 'plain' | 'spends' | 'destructive']> = [
  [createSandbox, 'create_sandbox', 'spends'],
  [deleteSandbox, 'delete_sandbox', 'destructive'],
  [runSandboxCode, 'run_sandbox_code', 'plain'],
  [runSandboxCommand, 'run_sandbox_command', 'plain'],
  [writeSandboxFile, 'write_sandbox_file', 'plain'],
];

test('sandbox writes: name, closed schema, one services:write, gate + annotations per kind', () => {
  for (const [tool, name, kind] of WRITES) {
    assert.equal(tool.name, name);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} closed schema`);
    assert.equal(tool.description.split('services:write').length - 1, 1, `${name} names services:write once`);
    assert.equal(tool.inputSchema.required?.includes('confirm') ?? false, kind !== 'plain', `${name} gate`);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, kind === 'destructive', name);
  }
});

test('sandbox writes: only create_sandbox offers idempotency_key', () => {
  for (const [tool, name] of WRITES) {
    assert.equal('idempotency_key' in tool.inputSchema.properties, name === 'create_sandbox', name);
  }
});

// --- create -------------------------------------------------------------------

test('create_sandbox: refuses without confirm and makes no request', async () => {
  for (const confirm of [undefined, false]) {
    const { client, calls } = fakeClient();
    const result = await createSandbox.handler(client, confirm === undefined ? {} : { confirm });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /create_sandbox was NOT executed because it spends money/);
    assert.deepEqual(calls, []);
  }
});

test('create_sandbox: POST /v1/sandboxes with an empty body by default, via the idempotent path', async () => {
  const { client, calls } = fakeClient();
  await createSandbox.handler(client, { confirm: true });
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/sandboxes', body: {}, idempotent: true }]);
});

test('create_sandbox: every option the route accepts goes into the body, run mode included', async () => {
  const { client, calls } = fakeClient();
  await createSandbox.handler(client, {
    template: 'node',
    image: 'ghcr.io/acme/app:1.2',
    timeoutMs: 600000,
    name: 'job-1',
    env: { API_KEY: 'sk-live-123' },
    labels: { team: 'data' },
    networkBlocked: true,
    run: { entrypoint: ['/bin/sh', '-c'], command: ['echo hi'] },
    idempotency_key: 'k-1',
    confirm: true,
  });
  assert.deepEqual(calls, [{
    method: 'POST',
    path: '/v1/sandboxes',
    body: {
      template: 'node',
      image: 'ghcr.io/acme/app:1.2',
      timeoutMs: 600000,
      name: 'job-1',
      env: { API_KEY: 'sk-live-123' },
      labels: { team: 'data' },
      networkBlocked: true,
      run: { entrypoint: ['/bin/sh', '-c'], command: ['echo hi'] },
    },
    idempotent: true,
  }]);
});

test('create_sandbox: run {} (the image\'s own program) is sent as given', async () => {
  const { client, calls } = fakeClient();
  await createSandbox.handler(client, { image: 'nginx:1.27', run: {}, confirm: true });
  assert.deepEqual(calls[0].body, { image: 'nginx:1.27', run: {} });
});

test('create_sandbox: advertises the route bounds (lifetime, name, image, run) in the JSON schema', () => {
  const props = createSandbox.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.timeoutMs.type, 'integer');
  assert.equal(props.timeoutMs.minimum, 1000);
  assert.equal(props.timeoutMs.maximum, 3600000);
  assert.match(String(props.timeoutMs.description), /60000/);
  assert.equal(props.name.pattern, '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
  assert.equal(props.image.maxLength, 512);
  assert.equal(props.networkBlocked.type, 'boolean');
  const run = props.run as { type: string; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
  assert.equal(run.type, 'object');
  assert.equal(run.additionalProperties, false);
  for (const k of ['entrypoint', 'command']) {
    assert.equal(run.properties[k].type, 'array');
    assert.equal(run.properties[k].minItems, 1);
    assert.equal(run.properties[k].maxItems, 64);
  }
  assert.match(String(props.template.description), /list_sandbox_templates/);
  assert.deepEqual(createSandbox.inputSchema.required, ['confirm']);
});

test('create_sandbox: rejects out-of-bounds input before any request', async () => {
  for (const bad of [
    { timeoutMs: 999 },
    { timeoutMs: 3600001 },
    { timeoutMs: 1.5 },
    { name: 'Bad_Name' },
    { name: '-x' },
    { image: ' nginx' },
    { image: 'x'.repeat(513) },
    { template: '' },
    { run: { command: [] } },
    { run: { args: ['x'] } },
    { run: { command: Array.from({ length: 65 }, () => 'a') } },
    { labels: { team: 1 } },
    { networkBlocked: 'yes' },
    { extra: 1 },
  ]) {
    const { client, calls } = fakeClient();
    const result = await createSandbox.handler(client, { ...bad, confirm: true });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.deepEqual(calls, [], JSON.stringify(bad));
  }
});

test('create_sandbox: a refused env value is named by position, never echoed', async () => {
  const { client, calls } = fakeClient();
  const result = await createSandbox.handler(client, {
    env: { OK: 'fine', DB_URL: { secret: 'postgres://u:hunter2@db' } },
    confirm: true,
  });
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
  const text = textOf(result);
  assert.match(text, /#2/);
  assert.ok(!text.includes('hunter2'), text);
  assert.ok(!text.includes('DB_URL'), text);
});

test('create_sandbox: never echoes env values in the result, even if the API sent them', async () => {
  const { client } = fakeClient(() => ({
    id: SBX,
    status: 'pending',
    envKeys: ['API_KEY'],
    env: { API_KEY: 'sk-live-123' },
  }));
  const result = await createSandbox.handler(client, { env: { API_KEY: 'sk-live-123' }, confirm: true });
  assert.equal(result.isError, undefined);
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  assert.ok(!text.includes('sk-live-123'), text);
  const data = JSON.parse(textOf(result));
  assert.deepEqual(data, { id: SBX, status: 'pending', envKeys: ['API_KEY'] });
});

test('create_sandbox: the API error is passed through and carries no env value', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'QUOTA_EXCEEDED', message: 'At most 8 sandboxes run at once.' }, { status: 409 });
  });
  const result = await createSandbox.handler(client, { env: { API_KEY: 'sk-live-123' }, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /QUOTA_EXCEEDED/);
  assert.ok(!textOf(result).includes('sk-live-123'));
});

test('create_sandbox: description covers billing, lifetime, the env secret rule and listing before a retry', () => {
  const d = createSandbox.description;
  assert.match(d, /per second/);
  assert.match(d, /expiresAt/);
  assert.match(d, /SECURITY: treat the env values you pass in as a secret/);
  assert.match(d, /envKeys/);
  assert.match(d, /list_sandboxes/);
  assert.match(d, /get_sandbox_logs/);
});

// --- create: sizes -------------------------------------------------------------

test('create_sandbox: size, or vcpu + ramGb, goes into the body as given', async () => {
  for (const [args, body] of [
    [{ size: 'xs' }, { size: 'xs' }],
    [{ template: 'base', size: '2xl' }, { template: 'base', size: '2xl' }],
    [{ vcpu: 2, ramGb: 12 }, { vcpu: 2, ramGb: 12 }],
    [{ vcpu: 1, ramGb: 1 }, { vcpu: 1, ramGb: 1 }],
    [{ vcpu: 8, ramGb: 32 }, { vcpu: 8, ramGb: 32 }],
  ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
    const { client, calls } = fakeClient();
    const result = await createSandbox.handler(client, { ...args, confirm: true });
    assert.equal(result.isError, undefined, JSON.stringify(args));
    assert.deepEqual(calls[0].body, body, JSON.stringify(args));
  }
});

test('create_sandbox: an invalid size or shape is refused locally with no request', async () => {
  for (const [bad, why] of [
    [{ size: 'xxl' }, /size/],
    [{ size: 'S' }, /size/],
    [{ size: 's', vcpu: 1, ramGb: 2 }, /either size or both vcpu and ramGb/],
    [{ size: 's', vcpu: 1 }, /either size or both vcpu and ramGb/],
    [{ size: 's', ramGb: 2 }, /either size or both vcpu and ramGb/],
    [{ vcpu: 2 }, /vcpu and ramGb go together/],
    [{ ramGb: 4 }, /vcpu and ramGb go together/],
    [{ vcpu: 0, ramGb: 1 }, /vcpu/],
    [{ vcpu: 9, ramGb: 32 }, /vcpu/],
    [{ vcpu: 1.5, ramGb: 4 }, /vcpu/],
    [{ vcpu: 1, ramGb: 0 }, /ramGb/],
    [{ vcpu: 8, ramGb: 33 }, /ramGb/],
    [{ vcpu: 2, ramGb: 1 }, /1 to 8 GB per vCPU/],
    [{ vcpu: 1, ramGb: 9 }, /1 to 8 GB per vCPU/],
    [{ vcpu: '2', ramGb: 4 }, /vcpu/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const { client, calls } = fakeClient();
    const result = await createSandbox.handler(client, { ...bad, confirm: true });
    assert.equal(result.isError, true, JSON.stringify(bad));
    assert.match(textOf(result), why, JSON.stringify(bad));
    assert.deepEqual(calls, [], JSON.stringify(bad));
  }
});

test('create_sandbox: advertises size, vcpu and ramGb with the API bounds in the JSON schema', () => {
  const props = createSandbox.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.size.type, 'string');
  assert.deepEqual(props.size.enum, ['xs', 's', 'm', 'l', 'xl', '2xl']);
  assert.match(String(props.size.description), /list_sandbox_sizes/);
  assert.equal(props.vcpu.type, 'integer');
  assert.equal(props.vcpu.minimum, 1);
  assert.equal(props.vcpu.maximum, 8);
  assert.equal(props.ramGb.type, 'integer');
  assert.equal(props.ramGb.minimum, 1);
  assert.equal(props.ramGb.maximum, 32);
  for (const k of ['vcpu', 'ramGb']) {
    assert.match(String(props[k].description), /size/, `${k} says it excludes size`);
    assert.match(String(props[k].description), /8 GB per vCPU/, `${k} names the ratio`);
  }
  assert.deepEqual(createSandbox.inputSchema.required, ['confirm'], 'size stays optional');
});

test('create_sandbox: description explains size vs vcpu + ramGb and points to list_sandbox_sizes', () => {
  const d = createSandbox.description;
  assert.match(d, /list_sandbox_sizes/);
  assert.match(d, /either size or both vcpu and ramGb/);
  assert.match(d, /size_unavailable/);
});

test('create_sandbox: 409 size_unavailable becomes a clear error that names list_sandbox_sizes', async () => {
  for (const field of ['size', 'vcpu', 'ramGb']) {
    const { client } = fakeClient(() => {
      throw new APIError(
        {
          code: 'CONFLICT',
          message: 'Size l (2 vCPU, 8 GB) is not available yet.',
          details: [{ field, message: 'size_unavailable' }],
        },
        { status: 409 },
      );
    });
    const result = await createSandbox.handler(client, { size: 'l', confirm: true });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /\[CONFLICT\] Size l \(2 vCPU, 8 GB\) is not available yet\./, 'keeps the API message');
    assert.match(text, /size_unavailable/);
    assert.match(text, /nothing was created/i);
    assert.match(text, /list_sandbox_sizes/);
    assert.match(text, /available/);
  }
});

test('create_sandbox: any other 409 is passed through unchanged', async () => {
  const { client } = fakeClient(() => {
    throw new APIError(
      { code: 'CONFLICT', message: 'Name in use.', details: [{ field: 'name', message: 'name_taken' }] },
      { status: 409 },
    );
  });
  const result = await createSandbox.handler(client, { name: 'job-1', confirm: true });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [CONFLICT] Name in use.');
});

// --- delete -------------------------------------------------------------------

test('delete_sandbox: DELETE /v1/sandboxes/{id} only with confirm; id from list_sandboxes', async () => {
  const { client, calls } = fakeClient();
  assert.equal((await deleteSandbox.handler(client, { id: SBX })).isError, true);
  assert.deepEqual(calls, []);
  await deleteSandbox.handler(client, { id: SBX, confirm: true });
  assert.deepEqual(calls, [{ method: 'DELETE', path: `/v1/sandboxes/${SBX}` }]);
  assert.match((deleteSandbox.inputSchema.properties.id as { description: string }).description, /list_sandboxes/);
  assert.match(deleteSandbox.description, /Safety: IRREVERSIBLE;/);
});

// --- exec ---------------------------------------------------------------------

test('run_sandbox_code: POST /run_code { language, code }', async () => {
  const { client, calls } = fakeClient(() => ({ stdout: '2\n', stderr: '', exitCode: 0 }));
  const result = await runSandboxCode.handler(client, { id: SBX, language: 'python', code: 'print(1+1)' });
  assert.deepEqual(calls, [{ method: 'POST', path: `/v1/sandboxes/${SBX}/run_code`, body: { language: 'python', code: 'print(1+1)' } }]);
  assert.deepEqual(JSON.parse(textOf(result)), { stdout: '2\n', stderr: '', exitCode: 0 });
});

test('run_sandbox_code: language python|node and code 1-100000 enforced before any request', async () => {
  for (const bad of [
    { language: 'ruby', code: 'x' },
    { language: 'python', code: '' },
    { language: 'python', code: 'x'.repeat(100_001) },
    { code: 'x' },
  ]) {
    const { client, calls } = fakeClient();
    assert.equal((await runSandboxCode.handler(client, { id: SBX, ...bad })).isError, true, JSON.stringify(bad).slice(0, 60));
    assert.deepEqual(calls, []);
  }
  const props = runSandboxCode.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(props.language.enum, ['python', 'node']);
  assert.equal(props.code.maxLength, 100000);
});

test('run_sandbox_command: POST /commands { cmd }', async () => {
  const { client, calls } = fakeClient();
  await runSandboxCommand.handler(client, { id: SBX, cmd: 'ls -la /tmp' });
  assert.deepEqual(calls, [{ method: 'POST', path: `/v1/sandboxes/${SBX}/commands`, body: { cmd: 'ls -la /tmp' } }]);
});

test('run_sandbox_command: cmd 1-10000 enforced before any request', async () => {
  for (const bad of [{ cmd: '' }, { cmd: 'x'.repeat(10_001) }, {}]) {
    const { client, calls } = fakeClient();
    assert.equal((await runSandboxCommand.handler(client, { id: SBX, ...bad })).isError, true);
    assert.deepEqual(calls, []);
  }
  assert.equal((runSandboxCommand.inputSchema.properties.cmd as Record<string, unknown>).maxLength, 10000);
});

test('exec tools: describe the output cap, the time limit and truncated', () => {
  for (const t of [runSandboxCode, runSandboxCommand]) {
    assert.match(t.description, /300 seconds/, t.name);
    assert.match(t.description, /truncated/, t.name);
  }
});

// --- files --------------------------------------------------------------------

test('write_sandbox_file: PUT /files { path, content }, encoding only when given', async () => {
  const { client, calls } = fakeClient();
  await writeSandboxFile.handler(client, { id: SBX, path: '/home/user/a.py', content: 'print(1)' });
  await writeSandboxFile.handler(client, { id: SBX, path: '/tmp/b.bin', content: 'AAEC', encoding: 'base64' });
  await writeSandboxFile.handler(client, { id: SBX, path: '/tmp/empty', content: '' });
  assert.deepEqual(calls, [
    { method: 'PUT', path: `/v1/sandboxes/${SBX}/files`, body: { path: '/home/user/a.py', content: 'print(1)' } },
    { method: 'PUT', path: `/v1/sandboxes/${SBX}/files`, body: { path: '/tmp/b.bin', content: 'AAEC', encoding: 'base64' } },
    { method: 'PUT', path: `/v1/sandboxes/${SBX}/files`, body: { path: '/tmp/empty', content: '' } },
  ]);
  assert.match(writeSandboxFile.description, /overwrite/i);
});

test('write_sandbox_file: path absolute, no NUL, encoding base64 only; refused locally', async () => {
  for (const bad of [
    { path: 'rel.txt', content: 'x' },
    { path: '/a\0b', content: 'x' },
    { path: '/a', content: 'x', encoding: 'hex' },
    { path: '/a' },
  ]) {
    const { client, calls } = fakeClient();
    assert.equal((await writeSandboxFile.handler(client, { id: SBX, ...bad })).isError, true, JSON.stringify(bad));
    assert.deepEqual(calls, []);
  }
});

test('sandbox writes: every id segment rejects traversal with no request', async () => {
  const cases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [deleteSandbox, { confirm: true }],
    [runSandboxCode, { language: 'python', code: 'x' }],
    [runSandboxCommand, { cmd: 'ls' }],
    [writeSandboxFile, { path: '/a', content: 'x' }],
  ];
  for (const [tool, rest] of cases) {
    for (const bad of ['..', '.']) {
      const { client, calls } = fakeClient();
      const result = await tool.handler(client, { ...rest, id: bad });
      assert.equal(result.isError, true, `${tool.name} id=${bad}`);
      assert.deepEqual(calls, [], `${tool.name} id=${bad}`);
    }
  }
});

test('no sandbox tool exposes a port (the API answers 501 by product decision)', async () => {
  const { TOOLS } = await import('./index.js');
  for (const t of TOOLS) {
    assert.ok(!/port/.test(t.name) || !/sandbox/.test(t.name), `${t.name} must not exist`);
  }
  for (const [tool] of WRITES) {
    const { client, calls } = fakeClient();
    const args: Record<string, unknown> = {
      create_sandbox: { confirm: true },
      delete_sandbox: { id: SBX, confirm: true },
      run_sandbox_code: { id: SBX, language: 'python', code: 'x' },
      run_sandbox_command: { id: SBX, cmd: 'ls' },
      write_sandbox_file: { id: SBX, path: '/a', content: 'x' },
    }[tool.name] as Record<string, unknown>;
    await tool.handler(client, args);
    for (const c of calls) assert.doesNotMatch(c.path, /\/ports\//, tool.name);
  }
});
