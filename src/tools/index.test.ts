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

// The five write scopes below are named as an exact sorted set each. This
// rests on a convention enforced separately (see the invariant test further
// down): every write tool names its exact scope literal in its description,
// so scanning `description.includes(scope)` is a reliable proxy for "which
// tools carry this scope" — and any future tool quietly added under (or
// removed from) one of these scopes breaks the corresponding assertion here.
const withScope = (scope: string) =>
  TOOLS.filter((t) => t.description.includes(scope)).map((t) => t.name).sort();

test('exclusion guard: the account/billing/tickets write surface is EXACTLY the safe set', () => {
  // Scan the advertised description surface for the scope string. These three
  // write scopes are introduced by Task 8, so the matching set must equal the
  // 12 intended tools — nothing more. Adding any forbidden write tool under one
  // of these scopes (e.g. top_up_credit as billing:write) breaks this test.
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

// ---------------------------------------------------------------------------
// Task 10 EXTENSION: now that the registry is final (156), pin the two
// remaining write-scope surfaces (services:write, domains:write) as exact
// sorted sets too — same rationale as the account/billing/tickets pin above.
// services:write is the big one: it covers services-write.ts + k8s-write.ts +
// infra-write.ts + firewall-lb-write.ts + proxies-write.ts (60 tools) — the
// README's "services:write covers IaaS AND proxies" note names this exact
// sharing. domains:write is domains-write.ts (7 tools).
// ---------------------------------------------------------------------------

test('exclusion guard: the services:write surface is EXACTLY the safe set (IaaS + k8s + proxies)', () => {
  assert.deepEqual(withScope('services:write'), [
    'add_cluster_pool',
    'add_firewall_rule',
    'add_load_balancer_member',
    'add_proxy_whitelisted_ip',
    'add_service_ssh_key',
    'add_service_ssh_key_to_library',
    'apply_service_ssh_key_library',
    'attach_firewall',
    'attach_network_vm',
    'attach_reserved_ip',
    'attach_volume',
    'cancel_proxy',
    'cancel_service',
    'create_cluster_kubeconfig',
    'create_firewall',
    'create_load_balancer',
    'create_network',
    'create_proxy_request',
    'create_service_backup',
    'create_volume',
    'delete_cluster_pool',
    'delete_firewall',
    'delete_firewall_rule',
    'delete_load_balancer',
    'delete_network',
    'delete_proxy_request',
    'delete_volume',
    'deploy_service',
    'destroy_service',
    'detach_firewall',
    'detach_reserved_ip',
    'detach_volume',
    'enable_cluster_ha',
    'mount_service_iso',
    'order_proxy',
    'reboot_service',
    'reinstall_service',
    'release_reserved_ip',
    'remove_load_balancer_member',
    'remove_proxy_whitelisted_ip',
    'rename_cluster_pool',
    'renew_proxy',
    'renew_service',
    'request_proxy_replacement',
    'reserve_ip',
    'reset_service_password',
    'resize_service',
    'revoke_cluster_kubeconfig',
    'set_cluster_scale',
    'set_proxy_auth_method',
    'set_proxy_auto_renew',
    'set_proxy_credentials',
    'set_service_autorenew',
    'set_service_hostname',
    'set_service_password',
    'start_service',
    'stop_service',
    'unmount_service_iso',
    'update_cluster_pool',
    'upgrade_service',
  ]);
});

test('exclusion guard: the domains:write surface is EXACTLY the safe set', () => {
  assert.deepEqual(withScope('domains:write'), [
    'manage_domain',
    'register_domain',
    'renew_domain',
    'set_domain_contacts',
    'set_domain_dns',
    'set_domain_nameservers',
    'transfer_domain',
  ]);
});

// ---------------------------------------------------------------------------
// Convention invariant: every tool in the five write-scope sets above names
// EXACTLY ONE `:write` scope literal in its description (never zero, never
// two) — this is the assumption the six exact-set pins above rest on. If a
// tool's description ever names a second scope (or drops its scope literal
// entirely), the pins above would silently stop being a reliable proxy for
// "which tools carry this scope" without this test catching it.
// ---------------------------------------------------------------------------

test('exclusion guard convention: every write-scope tool names EXACTLY ONE :write scope literal', () => {
  const WRITE_SCOPES = ['account:write', 'billing:write', 'tickets:write', 'services:write', 'domains:write'];
  const allWriteToolNames = new Set(WRITE_SCOPES.flatMap((s) => withScope(s)));
  for (const t of TOOLS) {
    if (!allWriteToolNames.has(t.name)) continue;
    const matches = WRITE_SCOPES.filter((s) => t.description.includes(s));
    assert.equal(
      matches.length,
      1,
      `${t.name} must name exactly one :write scope literal, found: ${matches.join(', ') || '(none)'}`,
    );
  }
});
