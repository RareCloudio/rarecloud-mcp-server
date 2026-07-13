// Unit tests for the order read tools added in Parity Phase A / Task 3
// (list_orders, get_order). Fake client records the constructed path; no
// network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOrders, getOrder } from './orders.js';
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

// --- list_orders (no input) -----------------------------------------------

test('orders: list_orders — name, GETs /v1/orders, non-empty description', async () => {
  assert.equal(listOrders.name, 'list_orders');
  assert.ok(listOrders.description.trim().length > 0);
  const { client, calls } = fakeClient(() => ([]));
  const result = await listOrders.handler(client, {});
  assert.deepEqual(calls, ['/v1/orders']);
  assert.equal(result.isError, undefined);
});

// --- get_order ({id}) ------------------------------------------------------

test('orders: get_order — encodes id into /v1/orders/{id}', async () => {
  const { client, calls } = fakeClient(() => ({}));
  await getOrder.handler(client, { id: 'ord 1/2' });
  assert.deepEqual(calls, ['/v1/orders/ord%201%2F2']);
});

test('orders: get_order — requires id (closed schema, only id)', () => {
  assert.equal(getOrder.name, 'get_order');
  assert.deepEqual(getOrder.inputSchema.required, ['id']);
  assert.equal(getOrder.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(getOrder.inputSchema.properties), ['id']);
  assert.ok(getOrder.description.trim().length > 0);
});

test('orders: get_order — APIError maps to errorResult', async () => {
  const { client } = fakeClient(() => {
    throw new APIError({ code: 'NOT_FOUND', message: 'no such order' });
  });
  const result = await getOrder.handler(client, { id: 'ord-1' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Error: [NOT_FOUND] no such order');
});
