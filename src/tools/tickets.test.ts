// Unit tests for the tickets read tool added in Parity Phase A / Task 2
// (list support departments). Fake client records the constructed path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTicketDepartments } from './tickets.js';
import { APIError, type RareCloudClient } from '../client.js';
import type { ToolCallResult } from './types.js';

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

test('tickets: list_ticket_departments — name, GETs /v1/tickets/departments, non-empty description', async () => {
  assert.equal(listTicketDepartments.name, 'list_ticket_departments');
  assert.ok(listTicketDepartments.description.trim().length > 0);
  const { client, calls } = fakeClient(() => [{ id: 1, name: 'Support' }]);
  const result = await listTicketDepartments.handler(client, {});
  assert.deepEqual(calls, ['/v1/tickets/departments']);
  assert.equal(result.isError, undefined);
});

test('tickets: list_ticket_departments — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'FORBIDDEN', message: 'tickets:read required' });
  });
  const result = await listTicketDepartments.handler(client, {});
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [FORBIDDEN] tickets:read required');
});
