// Registry invariants. These pin the shape of the exposed tool surface so a
// later parity task can't silently break naming, drop a schema, or register a
// duplicate. The count is bumped intentionally by each task that adds tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, findTool } from './index.js';

// Bump this in the same commit that adds/removes tools. A mismatch means the
// registry changed without the test acknowledging it.
const EXPECTED_TOOL_COUNT = 156;

test('registry: tool count matches the expected total', () => {
  assert.equal(TOOLS.length, EXPECTED_TOOL_COUNT);
});

test('registry: every tool name is unique', () => {
  const names = TOOLS.map((t) => t.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, `duplicate tool name(s): ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`);
});

test('registry: every tool has a non-empty name and description', () => {
  for (const t of TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name.length > 0, 'empty tool name');
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.trim().length > 0, `empty description for ${t.name}`);
  }
});

test('registry: every tool has a well-formed object inputSchema', () => {
  for (const t of TOOLS) {
    assert.ok(t.inputSchema, `missing inputSchema for ${t.name}`);
    assert.equal(t.inputSchema.type, 'object', `inputSchema.type must be "object" for ${t.name}`);
    assert.equal(typeof t.inputSchema.properties, 'object', `inputSchema.properties must be an object for ${t.name}`);
  }
});

test('registry: findTool resolves a known tool and misses an unknown one', () => {
  assert.equal(findTool('list_services')?.name, 'list_services');
  assert.equal(findTool('definitely_not_a_tool'), undefined);
});

// ---------------------------------------------------------------------------
// Task 8 EXCLUSION GUARD (security-critical).
//
// Policy: an agent PAT manages INFRASTRUCTURE — never identity, credentials, or
// raw money movement. This guard proves the forbidden identity/credential/money
// operations have NO tool, and pins the exact safe account/billing/tickets
// write surface so a future task can't quietly add a forbidden one.
//
// STRENGTHENING (deviation from the brief's name-only check, reported in the
// Task-8 report): the factory's buildPath is a closure that is NOT exposed on
// ToolDefinition, and every write tool uses a .strict() zod input — which makes
// a runtime kitchen-sink path-probe vacuous (strict rejects the probe → no path
// is ever emitted). So instead of (only) a name blocklist, the guard ALSO pins
// the EXACT set of tools carrying each write scope by scanning the advertised
// description surface: if anyone later registers, say, a `top_up_credit` tool
// as billing:write, the billing:write set stops matching and this test fails.
// ---------------------------------------------------------------------------

// Comprehensive blocklist: no tool for any of these forbidden operations may
// exist. Names are a superset of the brief's list (several plausible aliases per
// operation) so a differently-named forbidden tool is still caught. Verified at
// authoring time to contain NO legitimately-registered tool name (e.g. the
// allowed reset_service_password / set_service_password / revoke_cluster_kubeconfig
// are deliberately NOT here — those manage a VM, not the account identity).
const FORBIDDEN_TOOL_NAMES = [
  // sub-user invite (POST /account/clients [+ /resend])
  'invite_account_client', 'invite_sub_user', 'add_account_client', 'create_account_client',
  'resend_account_client_invite', 'resend_sub_user_invite', 'resend_client_invite',
  // account password (POST /account/password)
  'change_account_password', 'set_account_password', 'update_account_password', 'change_password',
  // two-factor (POST /account/two-factor)
  'disable_two_factor', 'enable_two_factor', 'setup_two_factor', 'manage_two_factor', 'set_two_factor',
  'disable_2fa', 'enable_2fa', 'configure_2fa',
  // affiliate activate / withdraw (POST /account/affiliate/activate|withdraw)
  'activate_affiliate', 'enable_affiliate', 'withdraw_affiliate', 'request_affiliate_withdrawal', 'affiliate_withdraw',
  // credit top-up (POST /billing/credit/top-up)
  'top_up_credit', 'topup_credit', 'add_credit', 'credit_top_up',
  // pay invoice (POST /billing/invoices/{id}/pay)
  'pay_invoice', 'pay_bill', 'pay_invoices',
  // payment methods (POST/DELETE /billing/payment-methods[/{id}])
  'add_payment_method', 'create_payment_method', 'delete_payment_method', 'remove_payment_method',
  // API tokens (POST/DELETE /tokens — cookie-only anyway)
  'create_token', 'create_api_token', 'add_token', 'delete_token', 'revoke_token', 'delete_api_token', 'revoke_api_token',
  // vpanel act / SSO / checkout-url (browser-only / zero agent value)
  'vpanel_act', 'service_vpanel_action', 'vpanel_action', 'panel_sso', 'renew_sso', 'get_checkout_url', 'checkout_url',
] as const;

test('exclusion guard: no forbidden identity/credential/money tool is registered', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  const present = FORBIDDEN_TOOL_NAMES.filter((n) => names.has(n));
  assert.deepEqual(present, [], `forbidden tool(s) registered: ${present.join(', ')}`);
});

test('exclusion guard: the account/billing/tickets write surface is EXACTLY the safe set', () => {
  // Scan the advertised description surface for the scope string. These three
  // write scopes are introduced by Task 8, so the matching set must equal the
  // 12 intended tools — nothing more. Adding any forbidden write tool under one
  // of these scopes (e.g. top_up_credit as billing:write) breaks this test.
  const withScope = (scope: string) =>
    TOOLS.filter((t) => t.description.includes(scope)).map((t) => t.name).sort();

  assert.deepEqual(withScope('account:write'), [
    'add_account_ssh_key',
    'create_affiliate_link',
    'delete_account_ssh_key',
    'manage_account_contact',
    'resend_email_verification',
    'update_account',
  ]);
  assert.deepEqual(withScope('billing:write'), ['delete_billing_alert', 'redeem_voucher', 'set_billing_alert']);
  assert.deepEqual(withScope('tickets:write'), ['close_ticket', 'create_ticket', 'reply_ticket']);
});
