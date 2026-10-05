# @rarecloudio/mcp-server

Model Context Protocol server for the [RareCloud](https://rarecloud.io) API.

Drop into [Claude Code](https://claude.com/claude-code), Claude Desktop, [Cursor](https://cursor.com), or your own MCP client to let AI agents inspect, reason about, and now also **manage** your RareCloud account — list servers, browse the catalog, check billing, inspect cloud infrastructure, deploy a VM, resize it, attach storage, and more.

## What it does

Exposes **175 tools** wrapping the RareCloud REST API: **85 read tools** (inspect / list / get, always safe) plus **90 write/action tools** (deploy, resize, destroy, order, renew, and similar mutations, gated where money or irreversibility is involved). See [Reads + gated writes](#reads--gated-writes) below for how the gate works.

### Read tools (85)

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
| Orders | `list_orders` | The account's orders — the purchase records behind its services |
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
| | `get_cluster_kubeconfig` | Short-lived admin kubeconfig (expires in hours) — **live secret** |
| | `list_cluster_kubeconfigs` | Long-lived kubeconfig credentials, metadata only (token never returned) |
| | `download_cluster_kubeconfig` | Re-download a long-lived credential's kubeconfig (active-only) — **live secret** |
| Proxies | `list_proxies` | Residential proxy services: id, name, flavor, status, plan, expiry |
| | `get_proxy_catalog` | Proxy order-wizard catalog: ISP IP-count tiers + GB Residential buckets, pricing |
| | `get_proxy` | One proxy service: flavor, status, plan, location, expiry / renewal |
| | `get_proxy_list` | Live proxy endpoints + credentials for an ISP fixed-IP plan — **live secret** |
| | `get_proxy_auth` | Auth settings for a proxy service: method, credentials, IP whitelist — **live secret** |
| | `list_gb_residential_countries` | Countries selectable when creating a GB Residential proxy-request |
| | `list_gb_rotation_intervals` | Rotation intervals selectable for a GB Residential proxy-request |
| | `list_proxy_requests` | Proxy-requests on a GB Residential bucket (country + rotation + count groups) |
| | `get_proxy_request_list` | Live endpoints + credentials for one GB Residential proxy-request — **live secret** |
| | `get_proxy_replacements` | IP-replacement allowance + history for a proxy service |
| Container Registry | `registry_get` | The account's private OCI registry: handle, hostname, tier, status, live usage/quota/push state, linked-cluster counts |
| | `registry_tiers` | Billing tiers: storage quota, burst ceiling, monthly price (EUR/USD), overage rate, availability |
| | `registry_handle_suggest` | Up to 3 free, valid, non-reserved handle suggestions from a `base` string |
| | `registry_credentials_list` | Robot credentials (docker login / pull / push), metadata only, never a secret |
| | `registry_repositories_list` | Repositories under the account's registry handle, paginated |
| | `registry_repository_get` | One repository's tags, each with CVE severity counts |
| | `registry_repository_vulnerabilities` | Paginated CVE findings for one tag |
| | `registry_clusters_list` | Kubernetes clusters linked to the registry, with syncer health |

Tools marked **live secret** return a real credential (a kubeconfig bearer token, or proxy `ip:port:user:pass`). Their descriptions instruct the agent to treat the result as a secret and not echo it back unless you explicitly ask.

### Write / action tools (90)

Legend: **(spends)** = places a real order or otherwise charges the account; **(destructive — needs `confirm`)** = irreversibly tears something down; **(mints a secret, needs `confirm`)** = the result carries a live credential shown exactly once; **(disruptive, needs `confirm`)** = swaps or otherwise disturbs a live credential without showing it. All four kinds refuse to run, making **no** API call, unless the call passes `confirm:true`; an agent must always surface the action and its consequence to the user first. Tools with neither marker are plain writes (no charge, nothing torn down, no secret minted) and run unconditionally.

| Category | Tool | Purpose |
|---|---|---|
| Services | `set_service_hostname` | Set the hostname of a service (cloud VM or legacy VPS) |
| | `deploy_service` | Deploy (order + provision) a new service — polymorphic across VM / k8s / volume / load-balancer / network / proxy / domain **(spends)** |
| | `destroy_service` | Permanently destroy a service and release its resources **(destructive — needs `confirm`)** |
| | `resize_service` | Resize a cloud VM to a new flavor/plan **(spends)** |
| | `upgrade_service` | Create an upgrade order moving a service to a new product/plan **(spends)** |
| | `renew_service` | Ensure a renewal invoice exists for a service **(spends)** |
| | `cancel_service` | File a cancellation request — immediate or end-of-term **(destructive — needs `confirm`)** |
| | `set_service_autorenew` | Toggle auto-renew for a service |
| | `create_service_backup` | Create an on-demand backup of a legacy VPS |
| | `mount_service_iso` | Mount a rescue/install ISO on a VPS |
| | `unmount_service_iso` | Unmount the currently mounted ISO from a VPS |
| | `set_service_password` | Set the root/administrator password of a VPS **(destructive — needs `confirm`)** |
| | `start_service` | Power on a service |
| | `stop_service` | Power off a service |
| | `reboot_service` | Reboot a service |
| | `reinstall_service` | Reinstall (rebuild from scratch) a service, wiping the disk **(destructive — needs `confirm`)** |
| | `reset_service_password` | Reset the root password live via qemu-guest-agent, on a running cloud VM **(destructive — needs `confirm`)** |
| | `add_service_ssh_key` | Install an SSH public key directly onto a running service |
| | `add_service_ssh_key_to_library` | Register an SSH key in a legacy VPS's reinstall-time key library |
| | `apply_service_ssh_key_library` | Apply a set of library SSH keys to a legacy VPS, replacing the current set |
| Managed Kubernetes | `set_cluster_scale` | Set the autoscaling bounds of a cluster's first node pool |
| | `add_cluster_pool` | Add a named worker node pool **(spends)** |
| | `update_cluster_pool` | Edit an existing node pool's bounds / machineType / volume size |
| | `delete_cluster_pool` | Remove a worker node pool **(destructive — needs `confirm`)** |
| | `rename_cluster_pool` | Rename a worker node pool (rolls its nodes) |
| | `enable_cluster_ha` | Enable the HA control plane — add-only, irreversible **(spends)** |
| | `create_cluster_kubeconfig` | Mint a long-lived, revocable kubeconfig credential — **live secret** |
| | `revoke_cluster_kubeconfig` | Revoke a long-lived kubeconfig credential **(destructive — needs `confirm`)** |
| Cloud infra — volumes / networks / IPs | `create_volume` | Create a new block-storage volume **(spends)** |
| | `delete_volume` | Delete a block-storage volume permanently **(destructive — needs `confirm`)** |
| | `attach_volume` | Attach a volume to a cloud VM |
| | `detach_volume` | Detach a volume from a cloud VM |
| | `create_network` | Create a new private network (VPC) |
| | `delete_network` | Delete a private network (VPC) **(destructive — needs `confirm`)** |
| | `attach_network_vm` | Move a cloud VM into a private network |
| | `reserve_ip` | Reserve a new static public IP **(spends)** |
| | `release_reserved_ip` | Release (permanently delete) a reserved public IP **(destructive — needs `confirm`)** |
| | `attach_reserved_ip` | Attach a reserved public IP to a cloud VM |
| | `detach_reserved_ip` | Detach a reserved public IP from its VM |
| Cloud infra — firewalls / load balancers | `create_firewall` | Create a new cloud firewall (security group) |
| | `delete_firewall` | Delete a cloud firewall **(destructive — needs `confirm`)** |
| | `add_firewall_rule` | Add an inbound/outbound rule to a firewall |
| | `delete_firewall_rule` | Remove a rule from a firewall **(destructive — needs `confirm`)** |
| | `attach_firewall` | Attach a firewall to a cloud VM |
| | `detach_firewall` | Detach a firewall from a cloud VM |
| | `create_load_balancer` | Create a new L4 load balancer (VIP + listener + pool + floating IP) **(spends)** |
| | `delete_load_balancer` | Delete a load balancer **(destructive — needs `confirm`)** |
| | `add_load_balancer_member` | Add a VM as a member of a load-balancer pool |
| | `remove_load_balancer_member` | Remove a member from a load-balancer pool **(destructive — needs `confirm`)** |
| Domains | `register_domain` | Register a new domain name **(spends)** |
| | `transfer_domain` | Transfer a domain in from another registrar **(spends)** |
| | `renew_domain` | Renew an owned domain **(spends)** |
| | `set_domain_nameservers` | Replace an owned domain's nameservers (2-5) |
| | `set_domain_contacts` | Update an owned domain's registrant WHOIS contact |
| | `set_domain_dns` | Replace an owned domain's DNS host records |
| | `manage_domain` | Dispatch a single domain management action (nameservers / lock / autorenew / idprotect / epp) |
| Account | `update_account` | Update the account's billing / contact profile |
| | `add_account_ssh_key` | Add an account-wide SSH public key |
| | `delete_account_ssh_key` | Delete an account-wide SSH key **(destructive — needs `confirm`)** |
| | `resend_email_verification` | Resend the account's email-verification email |
| | `manage_account_contact` | Add, update, or delete a billing/technical contact |
| | `create_affiliate_link` | Mint a signed affiliate referral link (no money movement) |
| Billing | `set_billing_alert` | Set (or update) the month-to-date spend alert |
| | `delete_billing_alert` | Remove the month-to-date spend alert **(destructive — needs `confirm`)** |
| | `redeem_voucher` | Redeem a credit voucher / promo code (adds credit — never spends) |
| Support | `create_ticket` | Open a support ticket |
| | `reply_ticket` | Post a reply to an existing support ticket |
| | `close_ticket` | Close a support ticket |
| Proxies | `order_proxy` | Order a new residential proxy plan — ISP or GB Residential **(spends)** |
| | `renew_proxy` | Renew a proxy service for another billing term **(spends)** |
| | `set_proxy_auto_renew` | Turn a proxy service's auto-renew on/off |
| | `cancel_proxy` | Cancel a proxy service **(destructive — needs `confirm`)** |
| | `set_proxy_auth_method` | Switch a proxy service's authentication method |
| | `set_proxy_credentials` | Set a proxy service's username/password — secrets, never echoed |
| | `add_proxy_whitelisted_ip` | Add an IP to a proxy service's whitelist |
| | `remove_proxy_whitelisted_ip` | Remove an IP from a proxy service's whitelist **(destructive — needs `confirm`)** |
| | `request_proxy_replacement` | Request an IP replacement, consuming the monthly allowance |
| | `create_proxy_request` | Create a proxy-request on a GB Residential bucket |
| | `delete_proxy_request` | Delete a proxy-request from a GB Residential bucket **(destructive — needs `confirm`)** |
| Container Registry | `registry_enable` | Enable the registry, or reopen/re-enable a previously closed one |
| | `registry_set_tier` | Change the registry's billing tier |
| | `registry_close` | Close the registry (storage deletion is scheduled, not immediate) **(destructive — needs `confirm`)** |
| | `registry_credentials_create` | Create a robot credential for docker login / pull / push **(mints a secret, needs `confirm`)** |
| | `registry_credentials_revoke` | Revoke a robot credential immediately **(destructive — needs `confirm`)** |
| | `registry_repository_delete` | Delete an entire repository (every image in it) **(destructive — needs `confirm`)** |
| | `registry_tag_delete` | Delete one tag from a repository **(destructive — needs `confirm`)** |
| | `registry_cluster_link` | Link an owned Kubernetes cluster to the registry (installs a secret-syncer controller) |
| | `registry_cluster_unlink` | Unlink a cluster, removing everything the link installed **(destructive — needs `confirm`)** |
| | `registry_cluster_rotate` | Rotate a linked cluster's pull credential **(disruptive, needs `confirm`)** |
| | `registry_kubernetes_manifest` | Get a ready-to-apply pull-secret manifest for a BYO (self-managed) cluster **(mints a secret, needs `confirm`)** |

Notably absent by design: no password/2FA changes, no sub-user invites, no payment-method or API-token management, no credit top-up, no invoice payment, no affiliate activate/withdraw. Those are identity, credential, or raw-money-movement operations that stay out of an agent's reach; see [Reads + gated writes](#reads--gated-writes). Registry ROBOT credentials are a different, allowed class: infrastructure access material, not identity (spec CR-12); see [Reads + gated writes](#reads--gated-writes) below.

## Reads + gated writes

Every read tool above is always safe to call — it only ever inspects account state. Write tools mutate state, and the ones that spend money or destroy something are **gated**: they require an explicit `confirm: true` argument, and if it's missing the tool refuses immediately and issues **zero** API calls (no side effect, no partial charge, nothing to undo). The tool's own error message says so ("... was NOT executed ...") so the agent knows to go back and get the user's explicit go-ahead before retrying with `confirm:true`.

Two independent things are true of every gated tool:

- **`confirm: true` required** — the caller must actively opt in per call; there is no "confirm once, run twice" shortcut.
- **`destructiveHint` annotation** — set on the subset of gated tools whose effect is irreversible teardown (delete, revoke, cancel, remove-member, …), so an MCP client's own UI/guardrails can treat those more cautiously than a merely money-spending gated tool (deploy, resize, renew, …). See the legend above the write-tools table for which tools carry which marker.

A handful of tools also return a **live credential** in their result: long-lived kubeconfigs (`create_cluster_kubeconfig`, plus the read-only `get_cluster_kubeconfig` / `download_cluster_kubeconfig`), proxy endpoint/auth data (`get_proxy_list`, `get_proxy_auth`, `get_proxy_request_list`), and registry robot credentials (`registry_credentials_create`, `registry_kubernetes_manifest`). Their descriptions explicitly instruct the agent to treat the value as a secret, never echo it back or log it, and pass it straight to whatever consumes it unless the user explicitly asks to see it. The two registry tools additionally require `confirm: true` (spec CR-12) and append a one-line warning after the secret in their result, since the secret can never be retrieved again once shown.

For anything still outside the 90 write tools: the agent can read, recommend, and generate Terraform/CLI commands. The user copy-pastes them or runs them via [the RareCloud CLI](https://github.com/RareCloudio/rarecloud-cli).

## Install

Requires Node.js 20+ to run the published server. Contributors running the test suite locally need Node.js **21+** — `npm test` passes a glob (`src/**/*.test.ts`) straight to `node --test`, which only gained glob-pattern support in Node 21.

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
- An agent that can also act: add the matching `{domain}:write` scope(s): `services:write` (covers cloud VMs, managed Kubernetes, volumes, networks, reserved IPs, firewalls, load balancers, residential proxies, **and the container registry**, there is no separate proxy or registry scope), `domains:write`, `account:write`, `billing:write`, `tickets:write`.
- Full access: bare `*`.

Scope matching is **exact per token**: wildcard patterns like `*:read` are not supported; a token must carry the precise scope string a tool's description names. `account:write` / `billing:write` / `tickets:write` are deliberately narrow: they cover only the safe write tools listed above (profile fields, SSH keys, contacts, spend alerts, voucher redemption, tickets) and exclude every identity/credential/money-movement operation (password/2FA changes, sub-user invites, payment methods, API tokens, credit top-up, invoice payment, affiliate activate/withdraw); those simply have no tool here, gated or otherwise. Registry robot credentials (`registry_credentials_create`/`_revoke`, `registry_kubernetes_manifest`) are NOT part of that exclusion: they are infrastructure access material, the same class as SSH keys and kubeconfigs, not account identity (spec CR-12); see [Reads + gated writes](#reads--gated-writes) above.

Copy the token — shown once.

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
claude mcp add rarecloud npx -- -y @rarecloudio/mcp-server \
  -e RARECLOUD_API_TOKEN=rc_pat_...
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
- *"Mint a 90-day view-only kubeconfig for my cluster for CI"* → `create_cluster_kubeconfig`

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

Tests run on the built-in Node test runner (`node:test`) via `tsx`, no build step, no network. Each tool is exercised against an injected mock client that records the request path and returns a canned payload, so the suite asserts path construction, input-schema shape, JSON-vs-raw output, secret-handling guidance, and error mapping without ever calling the live API. For write tools, the same fake-client harness also proves the confirm gate makes zero requests when `confirm` is omitted, that both the zod input and the JSON `inputSchema` enforce the same bounds (mirrored both layers), and that every dynamic path segment is guarded against path traversal. A registry invariant test pins the exposed tool count (175) and enforces unique names, well-formed schemas, and, for the write-scope surfaces, an exact pinned set of tool names per scope, so a future change can't silently add a tool under the wrong scope.

## Security

- Tokens never touch shell history (we use env vars, not CLI flags).
- Each tool maps 1:1 to a RareCloud API endpoint; the MCP server doesn't aggregate or transform data beyond what the API returns.
- **Scope is exact-match per token, enforced server-side.** A token only unlocks the tools whose scope it carries; there is no wildcard scope matching (`*:read` does not imply `services:read`) and no client-side scope bypass — an unscoped or under-scoped token gets the API's own `[FORBIDDEN]` response back.
- **Writes exist and are gated.** 90 of the 175 tools mutate state. The ones that spend money or destroy something require `confirm:true` and make no API call at all without it (see [Reads + gated writes](#reads--gated-writes)). The remaining write tools are plain (no charge, nothing torn down) and run unconditionally once the token's scope allows them.
- **No identity/credential/money-movement surface, by design, not by gate.** Password/2FA changes, sub-user invites, payment-method management, API-token management, credit top-up, invoice payment, and affiliate activate/withdraw have no tool here at all — an agent holding even a maximally-scoped token cannot reach them. A registry test pins this exclusion list so a future change can't quietly add one back.
- The handful of tools that return live credentials (kubeconfigs — including the long-lived `create_cluster_kubeconfig` — and proxy endpoint/auth lists) carry explicit secret-handling guidance so the agent doesn't echo them back unprompted.
- Revoke a token at any time: **Dashboard → Account → API tokens**. Revocation is instant, no propagation delay.

## License

MIT.
