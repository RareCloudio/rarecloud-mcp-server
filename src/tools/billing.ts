// Billing tools — invoices, credit balance, payment methods.
// Read-only. AddFunds / payment-method mutations stay manual.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';

export const listInvoices: ToolDefinition = {
  name: 'list_invoices',
  description: 'List invoices for the authenticated account: number, status (paid / unpaid / cancelled), issued date, total. Use for "summarize my last 6 months of spend" or "which invoices are unpaid".',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['unpaid', 'paid', 'cancelled', 'refunded', 'collections'],
        description: 'Optional filter on invoice status.',
      },
      limit: {
        type: 'number',
        description: 'Cap results (default: 50, max: 200).',
      },
    },
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const data = await client.get('/v1/billing/invoices', {
        status: args.status as string | undefined,
        limit: args.limit as number | undefined,
      });
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getInvoice: ToolDefinition = {
  name: 'get_invoice',
  description: 'Get full details for a single invoice: every line item, taxes, payment method used, payment timestamp. Use after list_invoices when more detail is needed.',
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: {
        type: 'string',
        description: 'Invoice ID from list_invoices.',
      },
    },
    required: ['invoice_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.invoice_id as string;
      const data = await client.get(`/v1/billing/invoices/${encodeURIComponent(id)}`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getCreditBalance: ToolDefinition = {
  name: 'get_credit_balance',
  description: 'Get the current account credit balance (Pattern A v2 prepaid credit). Use for "how much do I have left?", or to check before suggesting actions that would consume credit (cloud-compute hourly billing).',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(client) {
    try {
      const data = await client.get('/v1/billing/credit');
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getCreditLedger: ToolDefinition = {
  name: 'get_credit_ledger',
  description: 'List credit ledger entries (top-ups, voucher redemptions, hourly metering debits, refunds) for the authenticated account. Use to explain "where did my credit go?" or to reconcile a balance.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(client) {
    try {
      const data = await client.get('/v1/billing/credit/ledger');
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};
