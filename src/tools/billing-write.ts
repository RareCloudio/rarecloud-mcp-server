// Billing-safe WRITE tools (Parity Phase B, Task 8). SECURITY POLICY: an agent
// PAT never moves raw money. These three are the ONLY billing writes that policy
// allows — set / delete a month-to-date spend ALERT (no money at all) and REDEEM
// a credit voucher (grants credit, no money OUT). Credit top-up, invoice pay, and
// payment-methods are EXCLUDED and have NO tool (proven by the registry exclusion
// guard in index.test.ts). All scope billing:write.
//
// Everything builds on the shared `writeTool` factory. delete_billing_alert is
// the only gated tool here (confirm + destructiveHint — see its note). Bodies +
// bounds re-confirmed against console openapi.json AND the route source
// (api/src/routes/v1-billing.ts):
//   - set_billing_alert: PUT /billing/alert, body { thresholdCents, enabled? }.
//     thresholdCents is an integer with a hard floor of 100 (€1) — the route
//     throws below that; openapi documents minimum:100. Mirrored in both layers.
//     enabled defaults true server-side.
//   - delete_billing_alert: DELETE /billing/alert — a SINGLETON, so there is NO
//     path segment and NO body.
//   - redeem_voucher: openapi DOC-GAP — the POST has NO requestBody documented,
//     but the route reads input.code (RedeemInput = z.object({ code:
//     z.string().min(1).max(64) }), v1-billing.ts:440-446). The ROUTE is
//     authoritative, so the body is { code } bounded 1-64. (openapi follow-up:
//     add the missing requestBody to the /billing/vouchers/redeem POST.)

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool } from './factories.js';

// --- set_billing_alert (PUT /v1/billing/alert, no gate) --------------------

export const setBillingAlert: ToolDefinition = writeTool({
  name: 'set_billing_alert',
  description:
    'Set (or update) the month-to-date spend alert. Requires scope billing:write. Plain write — not ' +
    'gated (no money moves; it only configures a notification). thresholdCents is the alert threshold in ' +
    'cents (minimum 100 = €1); enabled optionally turns the alert on/off (defaults on). See ' +
    'get_billing_alert for the current state.',
  method: 'PUT',
  input: z
    .object({
      thresholdCents: z.number().int().min(100, 'thresholdCents must be at least 100 (€1).'),
      enabled: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      thresholdCents: { type: 'integer', minimum: 100, description: 'Alert threshold in cents (min 100 = €1).' },
      enabled: { type: 'boolean', description: 'Turn the alert on/off (defaults on).' },
    },
    required: ['thresholdCents'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/billing/alert',
  buildBody: (a) => {
    const body: Record<string, unknown> = { thresholdCents: a.thresholdCents };
    if (a.enabled !== undefined) body.enabled = a.enabled;
    return body;
  },
});

// --- delete_billing_alert (DELETE /v1/billing/alert, confirm+destr) --------
// Low blast radius and re-creatable via set_billing_alert, so the confirm gate
// is arguably optional here — kept as confirm+destr for rule uniformity across
// the delete family (the description says so).

export const deleteBillingAlert: ToolDefinition = writeTool({
  name: 'delete_billing_alert',
  description:
    'Remove the month-to-date spend alert. Requires scope billing:write. Low blast radius and easily ' +
    're-created via set_billing_alert, but kept confirm-gated for uniformity with the other delete tools. ' +
    'Pass confirm:true only after the user has approved. Takes no other input (the alert is a singleton).',
  method: 'DELETE',
  input: z.object({}).strict(),
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  buildPath: () => '/v1/billing/alert',
  confirm: true,
  destructiveHint: true,
});

// --- redeem_voucher (POST /v1/billing/vouchers/redeem, no gate) ------------

export const redeemVoucher: ToolDefinition = writeTool({
  name: 'redeem_voucher',
  description:
    'Redeem a credit voucher / promo code, adding credit to the account balance. Requires scope ' +
    'billing:write. Plain write — not gated (it grants credit; no money leaves the account). code is the ' +
    'voucher code (1-64 chars).',
  method: 'POST',
  input: z.object({ code: z.string().min(1).max(64) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { code: { type: 'string', minLength: 1, maxLength: 64, description: 'The voucher / promo code.' } },
    required: ['code'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/billing/vouchers/redeem',
  buildBody: (a) => ({ code: a.code }),
});
