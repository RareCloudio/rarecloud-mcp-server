# @rarecloudio/mcp-server

Model Context Protocol server for the [RareCloud](https://rarecloud.io) API.

Drop into [Claude Code](https://claude.com/claude-code), Claude Desktop, [Cursor](https://cursor.com), or your own MCP client to let AI agents inspect, reason about, and now also **manage** your RareCloud account: list servers, browse the catalog, check billing, inspect cloud infrastructure, deploy a VM, resize it, attach storage, and more.

## What it does

Exposes **170 tools** wrapping the RareCloud REST API: **84 read tools** (inspect / list / get, always safe) plus **86 write/action tools** (deploy, resize, destroy, order, renew, and similar mutations). 63 of the writes are gated behind an explicit `confirm:true`; the other 23 are plain. See [Safety model](#safety-model) below for how it works.

### Read tools (84)

| Category | Tool | Purpose |
|---|---|---|
| Catalog | `list_catalog_products` | Orderable products in the catalog (filter by kind / backend) |
| | `get_catalog_plan` | Full product detail: plans (sizes), specs, per-cycle pricing, billing tracks |
| | `list_regions` | Available datacenter regions |
| | `list_images` | OS images (Ubuntu / Debian / Rocky / Windows Server / …) installable on new servers |
| | `get_product_details` | Order-ready detail for one SKU: cycles + prices, plans, config options |
| | `list_prepurchase_os_templates` | OS templates selectable at purchase time for a VPS / dedicated SKU |
| | `list_catalog_listings` | Deploy-wizard product cards for one category (the console "create" tiles) |
| | `list_kubernetes_versions` | Managed-Kubernetes (Gardener) versions on offer, newest-supported first |
| Services | `list_services` | All services in the account: VPS, cloud VMs, proxies, hosting, domains |
| | `get_service` | Full detail for one service: status, network, billing state, usage |
| | `get_service_metrics` | CPU / RAM / disk / bandwidth time series for one service |
| | `list_backups` | Backups for one legacy VPS |
| | `get_provisioning_state` | Setup state of a pending service (paid? VM exists yet? stuck?) |
| | `list_os_templates` | Operating systems a legacy VPS can be reinstalled with |
| | `list_upgrade_options` | Plans + cycles a service could upgrade / downgrade to |
| | `get_service_iso` | Mounted-ISO status for a legacy VPS (is a rescue/install ISO attached?) |
| | `list_service_ssh_key_library` | SSH keys registered in a legacy VPS's key library |
| | `get_service_autorenew` | Whether a service auto-renews from account balance |
| Orders | `list_orders` | The account's orders: the purchase records behind its services |
| | `get_order` | One order: line items, status, payment status, and its invoice |
| Billing | `list_invoices` | Invoice history: number, status, issued date, total |
| | `get_invoice` | Full invoice detail: line items, taxes, payment method + timestamp |
| | `get_credit_balance` | Current prepaid credit balance |
| | `get_credit_ledger` | Credit movements (top-ups, vouchers, metering debits, refunds) |
| | `get_invoice_pay_preview` | Preview what paying an invoice from balance would consume (bonus → credit → shortfall) |
| | `list_payment_methods` | Available payment options (WHMCS gateways) |
| | `get_billing_campaign` | The active credit (deposit-match) promo, or none |
| | `get_bonus_balance` | Promo (bonus) balance, in cents (EUR) |
| | `get_bonus_ledger` | Bonus-credit ledger: campaign grants and promo consumption |
| | `get_billing_alert` | Spending-alert state: threshold, month-to-date spend, triggered? |
| | `get_billing_state` | Cloud auto-suspend state (normal / grace-period / suspended) |
| Support | `list_tickets` | Support tickets: id, subject, status, department, last-updated |
| | `get_ticket` | One support ticket with its full message thread |
| | `list_ticket_departments` | Support departments + their ids (for opening a ticket) |
| Account | `get_account` | Profile: email, name, country, billing currency, creation date |
| | `list_ssh_keys` | SSH keys on a specific server (legacy VPS) |
| | `get_account_limits` | Resource limits and current usage (servers / vCPUs / IPs / volumes / …) |
| | `list_account_clients` | Users linked to this client account (accepted members + pending invites) |
| | `get_affiliate` | Affiliate status + stats: referral link, conversions, commissions, payouts |
| | `get_two_factor_status` | Whether 2FA (TOTP) is enabled on the account |
| | `list_account_ssh_keys` | Account-wide SSH public keys (offered at deploy time) |
| | `get_account_activity` | Account audit trail: sign-ins, 2FA changes, service + billing actions |
| | `list_account_emails` | Emails WHMCS sent to this account, newest first |
| | `list_account_contacts` | Billing / technical contacts (email-copy recipients, no login) |
| Cloud infrastructure | `list_volumes` | Block-storage volumes: id, name, size, status, attachment, region |
| | `get_volume` | One block-storage volume and which VM it is attached to |
| | `list_networks` | Private networks (VPCs): id, name, CIDR, status, attached VM count |
| | `get_network` | One private network (VPC) and its attached VMs |
| | `list_load_balancers` | L4 load balancers: id, name, status, public IP, port, member count |
| | `get_load_balancer` | One load balancer with its members (backend VMs + ports) |
| | `list_load_balancer_members` | Backend members of a load balancer (private fixed IP + port) |
| | `list_reserved_ips` | Reserved (static) public IPs and their attachments |
| | `list_firewalls` | Cloud firewalls (security groups): status, attached VMs, rule count |
| | `get_firewall` | One firewall with its full rule set and attached VMs |
| Object Storage | `get_object_storage` | The S3-compatible storage service: status, namespace handle, price card, month-to-date charge, limits (null if not enabled) |
| | `list_object_storage_regions` | Regions a bucket can be created in, with their S3 endpoints |
| | `get_object_storage_usage` | Daily usage series for the account: stored bytes, egress, CDN traffic (1-90 days) |
| | `list_buckets` | Buckets: id, full name, region, status, versioning, public (CDN) state, size |
| | `get_bucket` | One bucket: endpoint and URLs, public URL, versioning, size and object count |
| | `get_bucket_usage` | Daily usage series for one bucket (1-90 days) |
| | `list_object_storage_keys` | S3 access keys: id, name, access key id, scope, status (never the secret) |
| Domains | `list_domains` | Registered domains: id, name, status, expiry, auto-renew |
| | `get_domain` | One domain: nameservers, transfer lock, WHOIS privacy, auto-renew, expiry |
| | `check_domain_availability` | Whether a domain name is available to register |
| | `get_tld_pricing` | Register / transfer / renew prices per TLD, in the account currency |
| | `get_domain_nameservers` | Nameservers currently set on an owned domain |
| | `get_domain_contacts` | Registrant WHOIS contact on an owned domain |
| | `get_domain_dns` | DNS host records on an owned domain (A / CNAME / MX / TXT / …) |
| | `get_domain_management` | Combined management snapshot for an owned domain in one call |
| Managed Kubernetes | `get_cluster_scale` | Current scale of a managed K8s cluster: node pools + add-ons |
| | `list_cluster_pools` | Worker node pools: name, machine type, count, autoscale min/max |
| | `get_cluster_kubeconfig` | Short-lived admin kubeconfig (expires in hours), **live secret** |
| | `list_cluster_kubeconfigs` | Long-lived kubeconfig credentials, metadata only (token never returned) |
| | `download_cluster_kubeconfig` | Re-download a long-lived credential's kubeconfig (active-only), **live secret** |
| Proxies | `list_proxies` | Residential proxy services: id, name, flavor, status, plan, expiry |
| | `get_proxy_catalog` | Proxy order-wizard catalog: ISP IP-count tiers + GB Residential buckets, pricing |
| | `get_proxy` | One proxy service: flavor, status, plan, location, expiry / renewal |
| | `get_proxy_list` | Live proxy endpoints + credentials for an ISP fixed-IP plan, **live secret** |
| | `get_proxy_auth` | Auth settings for a proxy service: method, credentials, IP whitelist, **live secret** |
| | `list_gb_residential_countries` | Countries selectable when creating a GB Residential proxy-request |
| | `list_gb_rotation_intervals` | Rotation intervals selectable for a GB Residential proxy-request |
| | `list_proxy_requests` | Proxy-requests on a GB Residential bucket (country + rotation + count groups) |
| | `get_proxy_request_list` | Live endpoints + credentials for one GB Residential proxy-request, **live secret** |
| | `get_proxy_replacements` | IP-replacement allowance + history for a proxy service |

Tools marked **live secret** return a real credential (a kubeconfig bearer token, proxy `ip:port:user:pass`, or an S3 secret access key). Their descriptions carry the standard SECURITY sentence (see [Safety model](#safety-model)).

### Write / action tools (86)

The **Safety** column is each tool's kind (see [Safety model](#safety-model)). **spends**, **destructive**, **disruptive** and **sensitive** tools are gated (63 tools): they refuse to run, making **no** API call, unless the call passes `confirm:true`, so an agent must surface the action and its cost or consequence to the user first. **plain** tools (23) cost nothing, tear nothing down, and run without confirmation.

| Category | Tool | Safety | Purpose |
|---|---|---|---|
| Services | `set_service_hostname` | plain | Rename a service (legacy VPS hostname, or the cloud VM's server name) |
| | `deploy_service` | **spends** | Deploy (order + provision) a new service: polymorphic across VM / k8s / volume / load-balancer / network / proxy / domain (returns a **live secret**) |
| | `destroy_service` | **destructive** | Permanently destroy a service and release its resources |
| | `resize_service` | **spends** | Resize a cloud VM to a new flavor/plan |
| | `upgrade_service` | **spends** | Create an upgrade order moving a service to a new product/plan |
| | `renew_service` | **spends** | Ensure a renewal invoice exists for a service |
| | `cancel_service` | **destructive** | File a cancellation request: immediate or end-of-term |
| | `set_service_autorenew` | plain | Toggle auto-renew for a service |
| | `create_service_backup` | plain | Create an on-demand backup of a legacy VPS |
| | `mount_service_iso` | plain | Mount a rescue/install ISO on a VPS |
| | `unmount_service_iso` | plain | Unmount the currently mounted ISO from a VPS |
| | `set_service_password` | **disruptive** | Set the root/administrator password of a legacy VPS |
| | `start_service` | plain | Power on a service |
| | `stop_service` | **disruptive** | Power off a service |
| | `reboot_service` | **disruptive** | Reboot a service |
| | `reinstall_service` | **destructive** | Reinstall (rebuild from scratch) a service, wiping the disk (returns a **live secret**) |
| | `reset_service_password` | **disruptive** | Reset the root password live via qemu-guest-agent, on a running cloud VM |
| | `add_service_ssh_key` | **sensitive** | Install an SSH public key directly onto a running service |
| | `add_service_ssh_key_to_library` | plain | Register an SSH key in a legacy VPS's reinstall-time key library |
| | `apply_service_ssh_key_library` | **disruptive** | Apply a set of library SSH keys to a legacy VPS, replacing the current set |
| Managed Kubernetes | `set_cluster_scale` | **disruptive** | Set the autoscaling bounds of a cluster's first node pool |
| | `add_cluster_pool` | **spends** | Add a named worker node pool |
| | `update_cluster_pool` | **disruptive** | Edit an existing node pool's bounds / machineType / volume size |
| | `delete_cluster_pool` | **destructive** | Remove a worker node pool |
| | `rename_cluster_pool` | **disruptive** | Rename a worker node pool (rolls its nodes) |
| | `enable_cluster_ha` | **spends** | Enable the HA control plane: add-only, irreversible |
| | `create_cluster_kubeconfig` | **sensitive** | Mint a long-lived, revocable kubeconfig credential (returns a **live secret**) |
| | `revoke_cluster_kubeconfig` | **destructive** | Revoke a long-lived kubeconfig credential |
| Cloud infra: volumes / networks / IPs | `create_volume` | **spends** | Create a new block-storage volume |
| | `delete_volume` | **destructive** | Delete a block-storage volume permanently |
| | `attach_volume` | plain | Attach a volume to a cloud VM |
| | `detach_volume` | **disruptive** | Detach a volume from a cloud VM |
| | `create_network` | plain | Create a new private network (VPC) |
| | `delete_network` | **destructive** | Delete a private network (VPC) |
| | `attach_network_vm` | **disruptive** | Move a cloud VM into a private network |
| | `reserve_ip` | **spends** | Reserve a new static public IP |
| | `release_reserved_ip` | **destructive** | Release (permanently delete) a reserved public IP |
| | `attach_reserved_ip` | plain | Attach a reserved public IP to a cloud VM |
| | `detach_reserved_ip` | **disruptive** | Detach a reserved public IP from its VM |
| Cloud infra: firewalls / load balancers | `create_firewall` | plain | Create a new cloud firewall (security group) |
| | `delete_firewall` | **destructive** | Delete a cloud firewall |
| | `add_firewall_rule` | plain | Add an inbound/outbound rule to a firewall |
| | `delete_firewall_rule` | **destructive** | Remove a rule from a firewall |
| | `attach_firewall` | plain | Attach a firewall to a cloud VM |
| | `detach_firewall` | **disruptive** | Detach a firewall from a cloud VM |
| | `create_load_balancer` | **spends** | Create a new L4 load balancer (VIP + listener + pool + floating IP) |
| | `delete_load_balancer` | **destructive** | Delete a load balancer |
| | `add_load_balancer_member` | plain | Add a VM as a member of a load-balancer pool |
| | `remove_load_balancer_member` | **destructive** | Remove a member from a load-balancer pool |
| Object Storage | `enable_object_storage` | **spends** | Enable Object Storage (starts the monthly base fee); optional, the first bucket does it too |
| | `disable_object_storage` | **destructive** | Delete the storage account for good (only once every bucket is deleted and every key revoked) |
| | `create_bucket` | **spends** | Create a bucket (the first one enables or wakes the service and its base fee) |
| | `update_bucket` | **sensitive** | Toggle a bucket's versioning or public CDN delivery (public makes every object readable by anyone) |
| | `delete_bucket` | **destructive** | Delete a bucket; `purge:true` deletes every object in it first |
| | `create_object_storage_key` | **sensitive** | Create an S3 access key scoped to buckets + read/readwrite (returns a **live secret**, shown once) |
| | `delete_object_storage_key` | **destructive** | Revoke an S3 access key |
| Domains | `register_domain` | **spends** | Register a new domain name |
| | `transfer_domain` | **spends** | Transfer a domain in from another registrar |
| | `renew_domain` | **spends** | Renew an owned domain |
| | `set_domain_nameservers` | **disruptive** | Replace an owned domain's nameservers (2-5) |
| | `set_domain_contacts` | **sensitive** | Update an owned domain's registrant WHOIS contact |
| | `set_domain_dns` | **disruptive** | Replace an owned domain's DNS host records |
| | `manage_domain` | **sensitive** | Dispatch a single domain management action (nameservers / lock / autorenew / idprotect / epp) |
| Account | `update_account` | **sensitive** | Update the account's billing / contact profile |
| | `add_account_ssh_key` | plain | Add an account-wide SSH public key |
| | `delete_account_ssh_key` | **destructive** | Delete an account-wide SSH key |
| | `resend_email_verification` | plain | Resend the account's email-verification email |
| | `manage_account_contact` | **sensitive** | Add, update, or delete a billing/technical contact |
| | `create_affiliate_link` | plain | Mint a signed affiliate referral link (no money movement) |
| Billing | `set_billing_alert` | plain | Set (or update) the month-to-date spend alert |
| | `delete_billing_alert` | **destructive** | Remove the month-to-date spend alert |
| | `redeem_voucher` | plain | Redeem a credit voucher / promo code (adds credit: never spends) |
| Support | `create_ticket` | **sensitive** | Open a support ticket |
| | `reply_ticket` | **sensitive** | Post a reply to an existing support ticket |
| | `close_ticket` | plain | Close a support ticket |
| Proxies | `order_proxy` | **spends** | Order a new residential proxy plan: ISP or GB Residential (returns a **live secret**) |
| | `renew_proxy` | **spends** | Renew a proxy service for another billing term |
| | `set_proxy_auto_renew` | plain | Turn a proxy service's auto-renew on/off |
| | `cancel_proxy` | **destructive** | Cancel a proxy service |
| | `set_proxy_auth_method` | **disruptive** | Switch a proxy service's authentication method |
| | `set_proxy_credentials` | **disruptive** | Set a proxy service's username/password |
| | `add_proxy_whitelisted_ip` | plain | Add an IP to a proxy service's whitelist |
| | `remove_proxy_whitelisted_ip` | **destructive** | Remove an IP from a proxy service's whitelist |
| | `request_proxy_replacement` | **disruptive** | Request an IP replacement, consuming the monthly allowance |
| | `create_proxy_request` | plain | Create a proxy-request on a GB Residential bucket |
| | `delete_proxy_request` | **destructive** | Delete a proxy-request from a GB Residential bucket |

Notably absent by design: no password/2FA changes, no sub-user invites, no payment-method or API-token management, no credit top-up, no invoice payment, no affiliate activate/withdraw. Those are identity, credential, or raw-money-movement operations that stay out of an agent's reach: they have no tool at all (see [Security](#security)).

## Safety model

Every read tool only inspects account state and is always safe to call. Every write tool has exactly **one safety kind**, and everything safety-related is derived from it in one place (the `writeTool` factory), so no tool hand-writes its own warning:

| Kind | Meaning | Gated | `destructiveHint` |
|---|---|---|---|
| **plain** | No charge, nothing torn down, nothing running is interrupted | no | false |
| **spends** | Places an order or otherwise charges the account | yes | false |
| **destructive** | Irreversible: deletes data or a resource, revokes access, cancels a service | yes | true |
| **disruptive** | Reversible, but interrupts something running or locks someone out (power off, reboot, detach, move a VM between networks, roll a node pool, replace DNS, replace credentials or keys) | yes | true |
| **sensitive** | Grants access, changes ownership or legal data, or speaks for you (SSH key install, long-lived kubeconfig, domain contacts, account profile, support tickets) | yes | false |

- **Gated tools refuse with zero API calls unless the call passes `confirm: true`.** No side effect, no partial charge, nothing to undo. The refusal says what the tool would have done, for example `stop_service was NOT executed because it is disruptive: it powers the server off; everything running on it stops until it is started again.`, so the agent can go back to you for an explicit go-ahead. The confirm is per call; there is no "confirm once, run twice" shortcut.
- **Every description ends with one standard `Safety:` sentence** naming the kind and the concrete consequence, so the agent sees the same information before it calls.
- **Every tool carries MCP annotations.** All reads set `readOnlyHint: true` (so a client can auto-approve them), plus `idempotentHint: true` and `destructiveHint: false`. All writes set `readOnlyHint: false`, and `destructiveHint` is true for destructive and disruptive tools, so an MCP client's own guardrails can treat those more cautiously. Every tool sets `openWorldHint: true` (it talks to the live RareCloud API).
- **Credentials are marked.** Tools whose result contains a live credential (`deploy_service` and `reinstall_service` when they return a one-time console password, `order_proxy` for an ISP plan's proxy list, `create_cluster_kubeconfig`, `create_object_storage_key`, `get_cluster_kubeconfig`, `download_cluster_kubeconfig`, `get_proxy_list`, `get_proxy_auth`, `get_proxy_request_list`) carry one standard sentence: *SECURITY: the result contains ..., a live credential. Treat it as a secret: do not repeat it to the user, or write it to files or logs, unless the user explicitly asks; pass it straight to whatever needs it.* Tools that take a secret as input (`set_service_password`, `reset_service_password`, `set_proxy_credentials`) tell the agent never to echo the value back.

For anything outside the 86 write tools, the agent can read, recommend, and generate Terraform/CLI commands. You copy-paste them or run them via [the RareCloud CLI](https://github.com/RareCloudio/rarecloud-cli).

## Install

Requires Node.js **21+** (the package's `engines` field). The test suite needs it too: `npm test` passes a glob (`src/**/*.test.ts`) straight to `node --test`, which only gained glob-pattern support in Node 21.

```bash
npm install -g @rarecloudio/mcp-server
```

Or run directly with `npx`:

```bash
npx @rarecloudio/mcp-server
```

## Configure

Get an API token: **Dashboard → Account → API tokens → New token**. Pick scopes for what you want the agent to do:

- Read-only agent: the explicit read scopes `account:read`, `services:read`, `billing:read`, `domains:read`, `tickets:read`.
- An agent that can also act: add the matching `{domain}:write` scope(s): `services:write` (covers cloud VMs, managed Kubernetes, volumes, networks, reserved IPs, firewalls, load balancers, Object Storage, **and residential proxies**: there is no separate proxy scope), `domains:write`, `account:write`, `billing:write`, `tickets:write`.
- Full access: bare `*`.

Scope matching is **exact per token**: wildcard patterns like `*:read` are not supported; a token must carry the precise scope string a tool's description names. `account:write` / `billing:write` / `tickets:write` are deliberately narrow: they cover only the safe write tools listed above (profile fields, SSH keys, contacts, spend alerts, voucher redemption, tickets) and exclude every identity/credential/money-movement operation (password/2FA changes, sub-user invites, payment methods, API tokens, credit top-up, invoice payment, affiliate activate/withdraw): those simply have no tool here, gated or otherwise.

Copy the token; it is shown only once.

Set the env var:

```bash
export RARECLOUD_API_TOKEN="rc_pat_..."
```

Optional, for self-hosted / staging instances (defaults to `https://api.rarecloud.io`):

```bash
export RARECLOUD_API_ENDPOINT="https://your-instance.example.com"
```

## Use with Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "rarecloud": {
      "command": "npx",
      "args": ["-y", "@rarecloudio/mcp-server"],
      "env": {
        "RARECLOUD_API_TOKEN": "rc_pat_..."
      }
    }
  }
}
```

Restart Claude Desktop. The tools become available under the 🔌 menu.

## Use with Claude Code

```bash
claude mcp add rarecloud -e RARECLOUD_API_TOKEN=rc_pat_... -- npx -y @rarecloudio/mcp-server
```

## Use with Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rarecloud": {
      "command": "npx",
      "args": ["-y", "@rarecloudio/mcp-server"],
      "env": { "RARECLOUD_API_TOKEN": "rc_pat_..." }
    }
  }
}
```

## Example prompts

Once configured, try:

- *"What VPS plans do you offer in Frankfurt?"* → uses `list_catalog_products` + `list_regions`
- *"List my running servers and their monthly cost"* → `list_services` + per-service spec lookup
- *"Am I close to any resource limits?"* → `get_account_limits`
- *"Show my block volumes and which VM each is attached to"* → `list_volumes`
- *"Any unpaid invoices, and what would paying the latest one from my balance cost?"* → `list_invoices` + `get_invoice_pay_preview`
- *"Give me a Terraform config for a 2 vCPU / 4 GB VPS in The Hague"* → `get_catalog_plan` + composition
- *"Deploy a 2 vCPU / 4 GB VM in The Hague named web-01"* → `get_product_details` to confirm the plan and cost, then `deploy_service` with `confirm:true` once you approve
- *"Resize db-02 to the next size up"* → `list_upgrade_options` + `resize_service` (confirm required)
- *"Mint a 90-day view-only kubeconfig for my cluster for CI"* → `create_cluster_kubeconfig` (confirm required: it mints a long-lived credential)

## Develop locally

```bash
git clone https://github.com/RareCloudio/rarecloud-mcp-server
cd rarecloud-mcp-server
npm install
npm run dev      # runs from source via tsx
npm run build    # compiles to dist/
```

Then point Claude Desktop at your local checkout:

```json
{
  "mcpServers": {
    "rarecloud-dev": {
      "command": "node",
      "args": ["/absolute/path/to/rarecloud-mcp-server/dist/index.js"],
      "env": { "RARECLOUD_API_TOKEN": "rc_pat_..." }
    }
  }
}
```

## Testing

```bash
npm test
```

Tests run on the built-in Node test runner (`node:test`) via `tsx`: no build step, no network. Each tool is exercised against an injected mock client that records the request path and returns a canned payload, so the suite asserts path construction, input-schema shape, JSON-vs-raw output, secret-handling guidance, and error mapping without ever calling the live API. For write tools, the same fake-client harness also proves every gated tool (63, pinned by name and kind) refuses with its reason and makes zero requests when `confirm` is omitted, that every tool carries the right MCP annotations, that both the zod input and the JSON `inputSchema` enforce the same bounds (mirrored both layers), and that every dynamic path segment is guarded against path traversal. A registry invariant test pins the exposed tool count (170) and enforces unique names, well-formed schemas, and, for the write-scope surfaces, an exact pinned set of tool names per scope, so a future change can't silently add a tool under the wrong scope.

## Security

- Tokens never touch shell history (we use env vars, not CLI flags).
- Each tool maps 1:1 to a RareCloud API endpoint; the MCP server doesn't aggregate or transform data beyond what the API returns.
- **Scope is exact-match per token, enforced server-side.** A token only unlocks the tools whose scope it carries; there is no wildcard scope matching (`*:read` does not imply `services:read`) and no client-side scope bypass: an unscoped or under-scoped token gets the API's own `[FORBIDDEN]` response back.
- **Writes exist and are gated.** 86 of the 170 tools mutate state. The 63 that spend money, destroy something, disrupt something running, or are security-sensitive require `confirm:true` and make no API call at all without it (see [Safety model](#safety-model)). The remaining 23 are plain (no charge, nothing torn down) and run without confirmation once the token's scope allows them.
- **No identity/credential/money-movement surface, by design, not by gate.** Password/2FA changes, sub-user invites, payment-method management, API-token management, credit top-up, invoice payment, and affiliate activate/withdraw have no tool here at all: an agent holding even a maximally-scoped token cannot reach them. A registry test pins this exclusion list so a future change can't quietly add one back.
- The tools that return live credentials (kubeconfigs, proxy endpoint/auth lists, one-time console passwords) carry the standard SECURITY sentence so the agent doesn't echo them back unprompted.
- Revoke a token at any time: **Dashboard → Account → API tokens**. Revocation is instant, no propagation delay.

## License

MIT.
