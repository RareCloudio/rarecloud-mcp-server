// Billing tools — invoices, credit balance, payment methods, pay-preview,
// campaign, promo (bonus) balance/ledger, spending alert, auto-suspend state.
// Read-only. AddFunds / payment-method mutations stay manual.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';
import { readList, readTool, encodeSegment } from './factories.js';

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
      const id = encodeSegment(args.invoice_id, 'invoice_id');
      const data = await client.get(`/v1/billing/invoices/${id}`);
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

export const getInvoicePayPreview = readTool({
  name: 'get_invoice_pay_preview',
  description: 'Preview what paying an invoice from the account balance would consume — promo bonus first, then real credit, then any remaining shortfall. Read-only; consumes nothing. Pass an invoice id from list_invoices. Use before discussing a "pay from balance" action.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Invoice id from list_invoices.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (args) => `/v1/billing/invoices/${encodeSegment(args.id, 'id')}/pay-preview`,
});

export const listPaymentMethods = readList(
  'list_payment_methods',
  '/v1/billing/payment-methods',
  'List the account\'s available payment options (WHMCS gateways). There is no stored-card vault — these are the gateways offered at checkout. Use for "how can I pay?".',
);

export const getBillingCampaign = readList(
  'get_billing_campaign',
  '/v1/billing/campaign',
  'Get the currently-active credit (deposit-match) campaign in public shape — the "double your credits" promo — or {campaign:null} when none is running. Check before suggesting a top-up so the user can catch a bonus match.',
);

export const getBonusBalance = readList(
  'get_bonus_balance',
  '/v1/billing/bonus',
  'Get the account\'s promo (bonus) balance in cents (EUR). This is a SEPARATE non-WHMCS balance that depletes first, as a taxed discount line, at consumption. Pair with get_credit_balance for the full "how much can I spend?" picture.',
);

export const getBonusLedger = readList(
  'get_bonus_ledger',
  '/v1/billing/bonus/ledger',
  'List all bonus-credit ledger entries (newest first): campaign grants (positive) and promo consumption (negative). Use to explain "where did my bonus go?" — distinct from get_credit_ledger, which tracks real (WHMCS) credit.',
);

export const getBillingAlert = readList(
  'get_billing_alert',
  '/v1/billing/alert',
  'Get the spending-alert state: the configured threshold, month-to-date spend, and whether the alert has triggered. Use for "am I close to my spending alert?".',
);

export const getBillingState = readList(
  'get_billing_state',
  '/v1/billing/state',
  'Get the cloud auto-suspend state for the account — normal / grace-period / suspended — that drives the dashboard billing banner. Use to check whether a low balance is putting services at risk of suspension.',
);
