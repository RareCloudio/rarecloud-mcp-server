// Registry invariants. These pin the shape of the exposed tool surface so a
// later parity task can't silently break naming, drop a schema, or register a
// duplicate. The count is bumped intentionally by each task that adds tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, findTool } from './index.js';
import type { RareCloudClient } from '../client.js';

// Bump this in the same commit that adds/removes tools. A mismatch means the
// registry changed without the test acknowledging it.
const EXPECTED_TOOL_COUNT = 170;

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
// Task 10 EXTENSION: now that the registry is final (156; 170 with Object Storage), pin the two
// remaining write-scope surfaces (services:write, domains:write) as exact
// sorted sets too — same rationale as the account/billing/tickets pin above.
// services:write is the big one: it covers services-write.ts + k8s-write.ts +
// infra-write.ts + firewall-lb-write.ts + object-storage-write.ts + proxies-write.ts (67 tools) — the
// README's "services:write covers IaaS AND proxies" note names this exact
// sharing. domains:write is domains-write.ts (7 tools).
// ---------------------------------------------------------------------------

test('exclusion guard: the services:write surface is EXACTLY the safe set (IaaS + k8s + object storage + proxies)', () => {
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
    'create_bucket',
    'create_cluster_kubeconfig',
    'create_firewall',
    'create_load_balancer',
    'create_network',
    'create_object_storage_key',
    'create_proxy_request',
    'create_service_backup',
    'create_volume',
    'delete_bucket',
    'delete_cluster_pool',
    'delete_firewall',
    'delete_firewall_rule',
    'delete_load_balancer',
    'delete_network',
    'delete_object_storage_key',
    'delete_proxy_request',
    'delete_volume',
    'deploy_service',
    'destroy_service',
    'detach_firewall',
    'detach_reserved_ip',
    'detach_volume',
    'disable_object_storage',
    'enable_cluster_ha',
    'enable_object_storage',
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
    'update_bucket',
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
// Convention invariant: every tool that names a `:write` scope literal names
// EXACTLY ONE (never two) — so no tool can appear in two of the exact-set
// pins above. NOTE the division of labor: this test can only see tools whose
// description already matches SOME scope literal (membership is derived via
// withScope), so it structurally CANNOT catch a write tool that drops its
// scope literal entirely. That "never zero" case is owned by the hardcoded
// exact-set pin arrays above: a pinned tool losing its literal falls out of
// withScope()'s output and breaks the deepEqual against the pinned list.
// Do NOT "simplify" the suite by dropping those hardcoded arrays in favor of
// this invariant — they are the only guard for the zero-literal case.
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

// ---------------------------------------------------------------------------
// SAFETY MODEL (tool-safety-metadata). Every tool carries MCP annotations;
// every write tool has exactly one safety kind, derived by the factory into
// the confirm gate, the refusal text, a single trailing "Safety:" sentence,
// and destructiveHint. The exact gated and plain sets are pinned below, each
// with its kind, so a reclassification is always a deliberate test change.
// ---------------------------------------------------------------------------

type Kind = 'plain' | 'spends' | 'destructive' | 'disruptive' | 'sensitive';

const GATED_TOOLS: Record<string, Exclude<Kind, 'plain'>> = {
  add_cluster_pool: 'spends',
  add_service_ssh_key: 'sensitive',
  apply_service_ssh_key_library: 'disruptive',
  attach_network_vm: 'disruptive',
  cancel_proxy: 'destructive',
  cancel_service: 'destructive',
  create_bucket: 'spends',
  create_cluster_kubeconfig: 'sensitive',
  create_load_balancer: 'spends',
  create_object_storage_key: 'sensitive',
  create_ticket: 'sensitive',
  create_volume: 'spends',
  delete_account_ssh_key: 'destructive',
  delete_billing_alert: 'destructive',
  delete_bucket: 'destructive',
  delete_cluster_pool: 'destructive',
  delete_firewall: 'destructive',
  delete_firewall_rule: 'destructive',
  delete_load_balancer: 'destructive',
  delete_network: 'destructive',
  delete_object_storage_key: 'destructive',
  delete_proxy_request: 'destructive',
  delete_volume: 'destructive',
  deploy_service: 'spends',
  destroy_service: 'destructive',
  detach_firewall: 'disruptive',
  detach_reserved_ip: 'disruptive',
  detach_volume: 'disruptive',
  disable_object_storage: 'destructive',
  enable_cluster_ha: 'spends',
  enable_object_storage: 'spends',
  manage_account_contact: 'sensitive',
  manage_domain: 'sensitive',
  order_proxy: 'spends',
  reboot_service: 'disruptive',
  register_domain: 'spends',
  reinstall_service: 'destructive',
  release_reserved_ip: 'destructive',
  remove_load_balancer_member: 'destructive',
  remove_proxy_whitelisted_ip: 'destructive',
  rename_cluster_pool: 'disruptive',
  renew_domain: 'spends',
  renew_proxy: 'spends',
  renew_service: 'spends',
  reply_ticket: 'sensitive',
  request_proxy_replacement: 'disruptive',
  reserve_ip: 'spends',
  reset_service_password: 'disruptive',
  resize_service: 'spends',
  revoke_cluster_kubeconfig: 'destructive',
  set_cluster_scale: 'disruptive',
  set_domain_contacts: 'sensitive',
  set_domain_dns: 'disruptive',
  set_domain_nameservers: 'disruptive',
  set_proxy_auth_method: 'disruptive',
  set_proxy_credentials: 'disruptive',
  set_service_password: 'disruptive',
  stop_service: 'disruptive',
  transfer_domain: 'spends',
  update_account: 'sensitive',
  update_bucket: 'sensitive',
  update_cluster_pool: 'disruptive',
  upgrade_service: 'spends',
};

const PLAIN_TOOLS = [
  'add_account_ssh_key',
  'add_firewall_rule',
  'add_load_balancer_member',
  'add_proxy_whitelisted_ip',
  'add_service_ssh_key_to_library',
  'attach_firewall',
  'attach_reserved_ip',
  'attach_volume',
  'close_ticket',
  'create_affiliate_link',
  'create_firewall',
  'create_network',
  'create_proxy_request',
  'create_service_backup',
  'mount_service_iso',
  'redeem_voucher',
  'resend_email_verification',
  'set_billing_alert',
  'set_proxy_auto_renew',
  'set_service_autorenew',
  'set_service_hostname',
  'start_service',
  'unmount_service_iso',
];

const SAFETY_TAG: Record<Kind, string> = {
  plain: 'Safety: plain write;',
  spends: 'Safety: SPENDS MONEY;',
  destructive: 'Safety: IRREVERSIBLE;',
  disruptive: 'Safety: DISRUPTIVE;',
  sensitive: 'Safety: SECURITY-SENSITIVE;',
};

// A write tool is any tool whose annotations say it is not read-only.
const writeTools = () => TOOLS.filter((t) => t.annotations.readOnlyHint === false);
const readTools = () => TOOLS.filter((t) => t.annotations.readOnlyHint === true);

// The tool-specific reason, as the factory embedded it in the Safety sentence.
function reasonOf(description: string): string {
  const m = /Safety: [A-Z -]+; this (.*)\. Requires confirm:true/.exec(description);
  assert.ok(m, `no gated Safety sentence in: ${description}`);
  return m[1];
}

test('safety: every tool (all 170) carries annotations; reads are readOnly, writes are not', () => {
  assert.equal(readTools().length + writeTools().length, TOOLS.length, 'every tool sets readOnlyHint');
  assert.equal(readTools().length, 84);
  assert.equal(writeTools().length, 86);
  for (const t of readTools()) {
    assert.deepEqual(
      t.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      `${t.name} read annotations`,
    );
  }
});

test('safety: the gated set (63) and the plain set (23) are exactly the pinned ones', () => {
  const gated = writeTools().filter((t) => 'confirm' in t.inputSchema.properties).map((t) => t.name).sort();
  const plain = writeTools().filter((t) => !('confirm' in t.inputSchema.properties)).map((t) => t.name).sort();
  assert.deepEqual(gated, Object.keys(GATED_TOOLS).sort());
  assert.deepEqual(plain, [...PLAIN_TOOLS].sort());
  assert.equal(gated.length, 63);
  assert.equal(plain.length, 23);
});

test('safety: each write tool carries its kind (Safety tag + destructiveHint + openWorldHint)', () => {
  for (const t of writeTools()) {
    const kind: Kind = GATED_TOOLS[t.name] ?? 'plain';
    assert.ok(t.description.includes(SAFETY_TAG[kind]), `${t.name} must carry "${SAFETY_TAG[kind]}"`);
    assert.deepEqual(
      t.annotations,
      { readOnlyHint: false, destructiveHint: kind === 'destructive' || kind === 'disruptive', openWorldHint: true },
      `${t.name} write annotations for kind=${kind}`,
    );
  }
});

test('safety: every write description ends with exactly one "Safety:" sentence', () => {
  for (const t of writeTools()) {
    assert.equal(t.description.split('Safety:').length - 1, 1, `${t.name} must have exactly one Safety sentence`);
    const tail = t.description.slice(t.description.indexOf('Safety:'));
    assert.ok(
      tail === 'Safety: plain write; no charge, nothing torn down, runs without confirmation.' ||
        /^Safety: [A-Z -]+; this [^]*\. Requires confirm:true, only after the user [^]*\.$/.test(tail),
      `${t.name} Safety sentence must be the last sentence: ${tail}`,
    );
  }
  for (const t of readTools()) {
    assert.ok(!t.description.includes('Safety:'), `${t.name} is a read and carries no Safety sentence`);
  }
});

test('safety: no description carries stale hand-written safety phrasing', () => {
  for (const t of TOOLS) {
    for (const phrase of [/Plain write/, /not destructive/i, /not gated/i, /not exposed/i, /and\/or is irreversible/i]) {
      assert.doesNotMatch(t.description, phrase, `${t.name} description must not say ${phrase}`);
    }
    assert.ok(!t.description.includes('—'), `${t.name} description must not contain an em dash`);
  }
});

test('safety: every gated confirm property names the tool-specific reason', () => {
  for (const name of Object.keys(GATED_TOOLS)) {
    const t = findTool(name)!;
    const confirm = t.inputSchema.properties.confirm as { type: string; description: string };
    assert.equal(confirm.type, 'boolean', `${name} confirm type`);
    assert.ok(t.inputSchema.required?.includes('confirm'), `${name} must require confirm`);
    assert.ok(confirm.description.includes(reasonOf(t.description)), `${name} confirm description must name the reason`);
  }
});

// Minimal VALID domain args per gated tool (validation runs before the gate,
// so the refusal can only be observed with otherwise-valid input).
const ID = { id: 'res-1' };
const SVC = { service_id: 'svc-1' };
const GATED_ARGS: Record<string, Record<string, unknown>> = {
  add_cluster_pool: { ...SVC, name: 'workers', minimum: 1, maximum: 2 },
  add_service_ssh_key: { ...SVC, public_key: 'ssh-ed25519 AAAA' },
  apply_service_ssh_key_library: { ...SVC },
  attach_network_vm: { ...ID, serverId: 'vm-1' },
  cancel_proxy: { ...ID },
  cancel_service: { ...SVC },
  create_bucket: { name: 'assets', region: 'eu-central-1' },
  create_cluster_kubeconfig: { ...SVC, name: 'ci', role: 'view' },
  create_load_balancer: { name: 'lb', port: 80, memberServerIds: ['vm-1'] },
  create_object_storage_key: { name: 'ci', buckets: '*', access: 'read' },
  create_ticket: { subject: 's', department: '1', priority: 'low', body: 'b' },
  create_volume: { sizeGb: 10 },
  delete_account_ssh_key: { ...ID },
  delete_billing_alert: {},
  delete_bucket: { ...ID, bucket_name: 'acme-assets' },
  delete_cluster_pool: { ...SVC, pool: 'workers' },
  delete_firewall: { ...ID },
  delete_firewall_rule: { ...ID, ruleId: 'r-1' },
  delete_load_balancer: { ...ID },
  delete_network: { ...ID },
  delete_object_storage_key: { ...ID },
  delete_proxy_request: { ...ID, reqId: 'q-1' },
  delete_volume: { ...ID },
  deploy_service: { productId: 'sku-1' },
  destroy_service: { ...SVC },
  detach_firewall: { ...ID, serverId: 'vm-1' },
  detach_reserved_ip: { ...ID },
  detach_volume: { ...ID, serverId: 'vm-1' },
  disable_object_storage: {},
  enable_cluster_ha: { ...SVC },
  enable_object_storage: {},
  manage_account_contact: { action: 'delete', id: 1 },
  manage_domain: { ...ID, action: 'epp' },
  order_proxy: { kind: 'residential-gb', gb: 1 },
  reboot_service: { ...SVC },
  register_domain: { domain: 'example.com' },
  reinstall_service: { ...SVC, imageId: 'ubuntu-24.04' },
  release_reserved_ip: { ...ID },
  remove_load_balancer_member: { ...ID, memberId: 'm-1' },
  remove_proxy_whitelisted_ip: { ...ID, ip: '203.0.113.5' },
  rename_cluster_pool: { ...SVC, pool: 'workers', name: 'pool2' },
  renew_domain: { ...ID },
  renew_proxy: { ...ID },
  renew_service: { ...SVC },
  reply_ticket: { ...ID, body: 'b' },
  request_proxy_replacement: { ...ID },
  reserve_ip: {},
  reset_service_password: { ...SVC, password: 'supersecret1' },
  resize_service: { ...SVC, flavor: 'c-2vcpu-4gb' },
  revoke_cluster_kubeconfig: { ...SVC, credential_id: 'c-1' },
  set_cluster_scale: { ...SVC, minimum: 1, maximum: 2 },
  set_domain_contacts: { ...ID, contact: { city: 'X' } },
  set_domain_dns: { ...ID, records: [] },
  set_domain_nameservers: { ...ID, nameservers: ['ns1.example.com', 'ns2.example.com'] },
  set_proxy_auth_method: { ...ID, method: 'password' },
  set_proxy_credentials: { ...ID, username: 'u', password: 'p' },
  set_service_password: { ...SVC, password: 'supersecret1' },
  stop_service: { ...SVC },
  transfer_domain: { domain: 'example.com', epp: 'code' },
  update_account: { city: 'X' },
  update_bucket: { ...ID, public: true },
  update_cluster_pool: { ...SVC, pool: 'workers', maximum: 3 },
  upgrade_service: { ...SVC, newProductId: 'p2', cycle: 'monthly' },
};

function recordingClient(): { client: RareCloudClient; calls: string[] } {
  const calls: string[] = [];
  const rec = (m: string) => async (path: string) => {
    calls.push(`${m} ${path}`);
    return { ok: true };
  };
  const client = { get: rec('GET'), post: rec('POST'), put: rec('PUT'), patch: rec('PATCH'), delete: rec('DELETE') };
  return { client: client as unknown as RareCloudClient, calls };
}

test('safety: every gated tool refuses without confirm, names its reason, and makes NO request', async () => {
  assert.deepEqual(Object.keys(GATED_ARGS).sort(), Object.keys(GATED_TOOLS).sort(), 'args table covers every gated tool');
  for (const [name, args] of Object.entries(GATED_ARGS)) {
    const t = findTool(name)!;
    for (const confirm of [undefined, false]) {
      const { client, calls } = recordingClient();
      const result = await t.handler(client, confirm === undefined ? { ...args } : { ...args, confirm });
      const text = result.content[0].type === 'text' ? result.content[0].text : '';
      assert.equal(result.isError, true, `${name} must refuse without confirm`);
      assert.ok(text.startsWith(`Error: ${name} was NOT executed because it `), `${name} refusal: ${text}`);
      assert.ok(text.includes(`: it ${reasonOf(t.description)}.`), `${name} refusal must name the reason: ${text}`);
      assert.deepEqual(calls, [], `${name} must make no request without confirm`);
    }
    // ...and the same args with confirm:true do reach the API (the args are valid).
    const { client, calls } = recordingClient();
    await t.handler(client, { ...args, confirm: true });
    assert.equal(calls.length, 1, `${name} must dispatch exactly one request with confirm:true`);
  }
});

// Tools whose RESULT holds a live credential carry the standard SECURITY
// sentence exactly once; no other tool carries it.
const RETURNS_SECRET = [
  'create_cluster_kubeconfig',
  'create_object_storage_key',
  'deploy_service',
  'download_cluster_kubeconfig',
  'get_cluster_kubeconfig',
  'get_proxy_auth',
  'get_proxy_list',
  'get_proxy_request_list',
  'order_proxy',
  'reinstall_service',
];

test('safety: exactly the credential-returning tools carry the standard SECURITY sentence, once', () => {
  const RESULT_SECRET = /SECURITY: the result contains [^]*?, a live credential\. Treat it as a secret: do not repeat it to the user, or write it to files or logs, unless the user explicitly asks; pass it straight to whatever needs it\./g;
  for (const t of TOOLS) {
    const n = (t.description.match(RESULT_SECRET) ?? []).length;
    assert.equal(n, RETURNS_SECRET.includes(t.name) ? 1 : 0, `${t.name}: SECURITY result sentence count`);
  }
});

test('safety: tools that take a secret as input carry the never-echo sentence', () => {
  for (const name of ['set_service_password', 'reset_service_password', 'set_proxy_credentials']) {
    assert.match(findTool(name)!.description, /SECURITY: treat .* you pass in as a secret \(a live credential\): never echo the value back/, name);
  }
});

test('safety: every serverId parameter says it is the cloud VM service_id from list_services', () => {
  for (const t of TOOLS) {
    for (const key of ['serverId', 'memberServerIds']) {
      const prop = t.inputSchema.properties[key] as { description?: string } | undefined;
      if (!prop) continue;
      assert.match(prop.description ?? '', /service_id from list_services/, `${t.name}.${key}`);
    }
  }
});

test('descriptions: every id parameter names the specific tool its value comes from', () => {
  // Caller-chosen ids (not looked up anywhere) are exempt.
  const CALLER_CHOSEN = new Set(['add_service_ssh_key.id']);
  for (const t of TOOLS) {
    for (const [key, prop] of Object.entries(t.inputSchema.properties)) {
      if (!/(^id$|Id$|_id$|Ids$)/.test(key) || key === 'taxId' || CALLER_CHOSEN.has(`${t.name}.${key}`)) continue;
      const d = (prop as { description?: string }).description ?? '';
      assert.match(d, /\b(list|get)_[a-z_]+[a-z]\b/, `${t.name}.${key} must name its source tool: "${d}"`);
      assert.ok(!d.includes('list_*'), `${t.name}.${key} must name a concrete tool, not list_*: "${d}"`);
    }
  }
});
