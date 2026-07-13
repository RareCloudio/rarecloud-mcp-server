// Unit tests for the Parity Phase B support-ticket WRITE tools (Task 8):
// open a ticket, reply to one, close one. A fake client records
// method+path+body (no network); we assert closed schemas, path + segment
// encoding, exact body shapes (incl. omit-undefined attachments), the
// traversal guard on each dynamic `id` segment, and both-layer constraint
// mirrors. All scope tickets:write (none is gated — a ticket is cheap + owner-
// scoped server-side).
//
// DEVIATION FROM BRIEF: the brief typed `priority:string` and
// `attachments?:unknown[]`, but the route (TicketCreateInput in v1-tickets.ts,
// confirmed by openapi) enforces priority as an ENUM (low|medium|high) and
// attachments as a STRUCTURED array of {name, data} (base64), max 5. Reality
// wins — modeled as an enum + a structured, bounded attachment schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicket, replyTicket, closeTicket } from './tickets-write.js';
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

test('task8 tickets: each tool names scope tickets:write, closed schema, no confirm, no foreign scope', () => {
  for (const tool of [createTicket, replyTicket, closeTicket]) {
    assert.match(tool.description, /tickets:write/, `${tool.name} description must name the scope`);
    assert.doesNotMatch(tool.description, /account:write|billing:write/, `${tool.name} must not name a foreign scope`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must have a closed schema`);
    assert.ok(!('confirm' in tool.inputSchema.properties), `${tool.name} is a plain write — no confirm`);
    assert.equal(tool.annotations, undefined, `${tool.name} must carry no destructiveHint`);
  }
});

// --- id-tool table: the two tools with a dynamic {id} path segment ---------
const ID_TOOLS: Record<string, { tool: ToolDefinition; args: Record<string, unknown> }> = {
  reply_ticket: { tool: replyTicket, args: { body: 'thanks' } },
  close_ticket: { tool: closeTicket, args: {} },
};

test('task8 tickets: id-tools require id and reject a ".." segment before any request', async () => {
  for (const [name, c] of Object.entries(ID_TOOLS)) {
    assert.ok((c.tool.inputSchema.required ?? []).includes('id'), `${name} must require id`);
    const { client, calls } = fakeWriteClient();
    const result = await c.tool.handler(client, { id: '..', ...c.args });
    assert.equal(result.isError, true, `${name} must reject ".."`);
    assert.equal(textOf(result), 'Error: Invalid id value', `${name} traversal message`);
    assert.deepEqual(calls, [], `${name} must issue no request for ".."`);
  }
});

// --- create_ticket (POST /v1/tickets, tickets:write) -----------------------

test('create_ticket: name + closed schema, priority is an enum (deviation: brief said string)', () => {
  assert.equal(createTicket.name, 'create_ticket');
  assert.deepEqual(createTicket.inputSchema.required, ['subject', 'department', 'priority', 'body']);
  const props = createTicket.inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.deepEqual(props.priority.enum, ['low', 'medium', 'high']);
});

test('create_ticket: POSTs the required fields to /v1/tickets (attachments omitted when absent)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createTicket.handler(client, {
    subject: 'VM will not boot',
    department: '1',
    priority: 'high',
    body: 'My VM is stuck.',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/tickets',
      body: { subject: 'VM will not boot', department: '1', priority: 'high', body: 'My VM is stuck.' },
    },
  ]);
});

test('create_ticket: forwards structured attachments when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createTicket.handler(client, {
    subject: 'Logs',
    department: '2',
    priority: 'low',
    body: 'See attached.',
    attachments: [{ name: 'boot.log', data: 'YmFzZTY0' }],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/tickets',
      body: {
        subject: 'Logs',
        department: '2',
        priority: 'low',
        body: 'See attached.',
        attachments: [{ name: 'boot.log', data: 'YmFzZTY0' }],
      },
    },
  ]);
});

test('create_ticket: rejects an invalid priority before any request (deviation from brief string)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await createTicket.handler(client, {
    subject: 'x',
    department: '1',
    priority: 'urgent',
    body: 'y',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for create_ticket:/);
  assert.deepEqual(calls, []);
});

test('create_ticket: rejects an empty subject / body and an over-long subject', async () => {
  const { client, calls } = fakeWriteClient();
  const bad = [
    { subject: '', department: '1', priority: 'low', body: 'y' },
    { subject: 'x', department: '1', priority: 'low', body: '' },
    { subject: 'x'.repeat(151), department: '1', priority: 'low', body: 'y' },
  ];
  for (const args of bad) {
    const result = await createTicket.handler(client, args);
    assert.equal(result.isError, true);
  }
  assert.deepEqual(calls, []);
});

test('create_ticket: rejects a malformed attachment (missing data / unknown key / over 5 items)', async () => {
  const { client, calls } = fakeWriteClient();
  const base = { subject: 'x', department: '1', priority: 'low' as const, body: 'y' };
  const bad = [
    { ...base, attachments: [{ name: 'a.log' }] }, // missing data
    { ...base, attachments: [{ name: 'a.log', data: 'YmFzZTY0', extra: 1 }] }, // unknown key
    { ...base, attachments: Array.from({ length: 6 }, () => ({ name: 'a.log', data: 'YmFzZTY0' })) }, // >5
  ];
  for (const args of bad) {
    const result = await createTicket.handler(client, args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error: Invalid input for create_ticket:/);
  }
  assert.deepEqual(calls, []);
});

test('create_ticket: schema mirrors subject/department/body bounds + attachments structure', () => {
  const props = createTicket.inputSchema.properties as {
    subject: { minLength?: number; maxLength?: number };
    department: { minLength?: number; maxLength?: number };
    body: { minLength?: number; maxLength?: number };
    attachments: {
      maxItems?: number;
      items: { properties: { name: { maxLength?: number }; data: { maxLength?: number } }; required?: string[] };
    };
  };
  assert.equal(props.subject.maxLength, 150);
  assert.equal(props.department.maxLength, 64);
  assert.equal(props.body.maxLength, 50000);
  assert.equal(props.attachments.maxItems, 5);
  assert.equal(props.attachments.items.properties.name.maxLength, 255);
  assert.equal(props.attachments.items.properties.data.maxLength, 7000000);
  assert.deepEqual(props.attachments.items.required, ['name', 'data']);
});

// --- reply_ticket (POST /v1/tickets/{id}/replies, tickets:write) -----------

test('reply_ticket: POSTs {body} to /v1/tickets/{id}/replies (attachments omitted)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await replyTicket.handler(client, { id: 'tkt-1', body: 'Any update?' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/tickets/tkt-1/replies', body: { body: 'Any update?' } }]);
});

test('reply_ticket: forwards attachments when supplied', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await replyTicket.handler(client, {
    id: 'tkt-1',
    body: 'See log',
    attachments: [{ name: 'x.log', data: 'YmFzZTY0' }],
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/v1/tickets/tkt-1/replies',
      body: { body: 'See log', attachments: [{ name: 'x.log', data: 'YmFzZTY0' }] },
    },
  ]);
});

test('reply_ticket: rejects an empty body before any request', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await replyTicket.handler(client, { id: 'tkt-1', body: '' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for reply_ticket:/);
  assert.deepEqual(calls, []);
});

// --- close_ticket (POST /v1/tickets/{id}/close, tickets:write, no body) ----

test('close_ticket: closed schema requires only id', () => {
  assert.deepEqual(closeTicket.inputSchema.required, ['id']);
  assert.deepEqual(Object.keys(closeTicket.inputSchema.properties), ['id']);
});

test('close_ticket: POSTs /v1/tickets/{id}/close with NO body', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await closeTicket.handler(client, { id: 'tkt-1' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/tickets/tkt-1/close', body: undefined }]);
});

test('close_ticket: rejects an unknown property (strict schema)', async () => {
  const { client, calls } = fakeWriteClient();
  const result = await closeTicket.handler(client, { id: 'tkt-1', reason: 'done' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Error: Invalid input for close_ticket:/);
  assert.deepEqual(calls, []);
});

// --- APIError mapping (representative) --------------------------------------

test('task8 tickets: APIError maps to a [CODE] message (representative)', async () => {
  const { client } = fakeWriteClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'tickets:write scope required' });
  });
  const result = await closeTicket.handler(client, { id: 'tkt-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] tickets:write scope required');
});
