// Tool descriptions are public documentation: an agent acts on them. These pin
// the sentences found false or stale against the API on 2026-11-03.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, findTool } from './index.js';

function description(name: string): string {
  const tool = findTool(name);
  assert.ok(tool, `no tool ${name}`);
  return tool.description;
}

const MUST_SAY: Array<[string, RegExp]> = [
  ['renew_proxy', /ISP and GB plans/],
  ['renew_proxy', /bandwidth is used up/],
  ['set_proxy_auto_renew', /ISP and mobile/],
  ['renew_service', /paid/],
  ['redeem_voucher', /bonus/],
  ['get_bonus_ledger', /voucher/],
  ['get_billing_state', /ok or suspended/],
  ['create_load_balancer', /public IP included/],
  ['cancel_service', /Legacy services only/],
  ['apply_service_ssh_key_library', /empty list changes nothing/],
  ['apply_service_ssh_key_library', /stopped and started/],
  ['apply_service_ssh_key_library', /Keys already installed stay/],
  ['add_service_ssh_key', /stopped and started/],
  ['get_account_limits', /get_quota_limits/],
  ['request_quota_increase', /opens a support ticket/],
  ['create_sandbox', /default size/],
  ['list_ssh_keys', /list_account_ssh_keys/],
  ['add_firewall_rule', /SMTP_EGRESS_NOT_APPROVED/],
  ['attach_firewall', /SMTP_EGRESS_NOT_APPROVED/],
  ['attach_network_vm', /SMTP_EGRESS_NOT_APPROVED/],
  ['deploy_service', /SMTP_EGRESS_NOT_APPROVED/],
  ['get_proxy', /closedReason/],
  ['get_proxy_bandwidth', /exhausted/],
  ['list_proxy_requests', /bandwidth is used up/],
  ['create_proxy_request', /bandwidth is used up/],
  ['cancel_proxy', /bandwidth is used up/],
  ['list_proxies', /mobile/],
  ['order_proxy', /Mobile lines cannot be ordered/],
];

const MUST_NOT_SAY: Array<[string, RegExp]> = [
  ['renew_proxy', /ISP proxy services only/],
  ['set_proxy_auto_renew', /ISP proxy services only/],
  ['renew_service', /settles it from the account balance/],
  ['redeem_voucher', /adding credit/],
  ['get_credit_ledger', /voucher/],
  ['get_billing_state', /grace-period/],
  ['create_load_balancer', /each billed hourly/],
  ['request_proxy_replacement', /support ticket/],
  ['request_proxy_replacement', /from the provider/],
  ['create_load_balancer', /EUR 9/],
  ['list_payment_methods', /WHMCS/],
  ['get_bonus_balance', /WHMCS/],
  ['get_bonus_ledger', /WHMCS/],
  ['cancel_service', /stops it now/],
  ['apply_service_ssh_key_library', /replac/],
  ['apply_service_ssh_key_library', /removes them all/],
  ['add_service_ssh_key', /running service/],
  ['get_account_limits', /DNS zones/],
  ['request_quota_increase', /a large one/],
  ['create_sandbox', /picks size and price/],
  ['list_ssh_keys', /not account-wide/],
  ['get_credit_balance', /Pattern A/],
  ['cancel_proxy', /upstream teardown/],
  ['list_proxy_replacement_locations', /proxy provider/],
  ['list_registry_tiers', /before launch/],
];

test('descriptions: say what the API does', () => {
  for (const [name, re] of MUST_SAY) {
    assert.match(description(name), re, `${name} should match ${re}`);
  }
});

test('descriptions: no longer say what the API does not do', () => {
  for (const [name, re] of MUST_NOT_SAY) {
    assert.doesNotMatch(description(name), re, `${name} should not match ${re}`);
  }
});

test('descriptions: the registry launched, so no tool says "until the registry launches"', () => {
  for (const t of TOOLS) {
    assert.doesNotMatch(t.description, /Until the registry launches/, t.name);
  }
});

test('list_catalog_products: kind offers every kind the API filter accepts for sale', () => {
  const kind = findTool('list_catalog_products')!.inputSchema.properties.kind as { enum: string[] };
  for (const k of ['cloud_loadbalancer', 'cloud_reserved_ip', 'cloud_object_storage', 'legacy_vps', 'cloud_compute']) {
    assert.ok(kind.enum.includes(k), `kind enum should include ${k}`);
  }
});
