// Orders tools — wrap /v1/orders. Read-only: an order is the purchase record
// (items, payment status, linked invoice) that a service is provisioned from.
// Placing/paying orders is a write flow and is not exposed as an MCP tool.

import { readList, readOne } from './factories.js';

export const listOrders = readList(
  'list_orders',
  '/v1/orders',
  'List the authenticated account\'s orders — the purchase records behind its services. Each has an id, orderNumber, date, status, paymentStatus, the linked invoiceId, and its line items. Use for "what have I ordered?" or to find an order id to inspect.',
);

export const getOrder = readOne(
  'get_order',
  '/v1/orders',
  'Get one order by id: its line items (product, plan, cycle, price), status, paymentStatus, and the invoice it belongs to. Use after list_orders to see exactly what a purchase contained. The id comes from list_orders.',
);
