# @rarecloudio/mcp-server

Model Context Protocol server for the [RareCloud](https://rarecloud.io) API.

Drop into [Claude Code](https://claude.com/claude-code), Claude Desktop, [Cursor](https://cursor.com), or your own MCP client to let AI agents inspect and reason about your RareCloud account — list servers, browse the catalog, check billing, inspect cloud infrastructure, plan deployments.

## What it does

Exposes **78 read-only tools** wrapping the RareCloud REST API:

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
| | `get_vpanel_status` | Whether a legacy VPS's management panel (Virtualizor) is reachable |
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

Tools marked **live secret** return a real credential (a kubeconfig bearer token, or proxy `ip:port:user:pass`). Their descriptions instruct the agent to treat the result as a secret and not echo it back unless you explicitly ask.

## Read-only by design

This release is **read-only**. No `create_server`, no `destroy`, no `snapshot create`. The reason is architectural: mutating actions need a derived, scoped token plus a mandatory plan-and-approve step before they're safe to expose to an LLM. That ships in a future release.

In the meantime: the agent can read, recommend, and generate Terraform/CLI commands. The user copy-pastes them or runs them via [the RareCloud CLI](https://github.com/RareCloudio/rarecloud-cli).

## Install

Requires Node.js 20+.

```bash
npm install -g @rarecloudio/mcp-server
```

Or run directly with `npx`:

```bash
npx @rarecloudio/mcp-server
```

## Configure

Get an API token: **Dashboard → Account → API tokens → New token**. For a read-only agent token, select the explicit read scopes `account:read`, `services:read`, `billing:read`, `domains:read`, `tickets:read` — or bare `*` for full access. (Scope matching is exact; wildcard patterns like `*:read` are not supported.) Copy the token — shown once.

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

Tests run on the built-in Node test runner (`node:test`) via `tsx` — no build step, no network. Each tool is exercised against an injected mock client that records the request path and returns a canned payload, so the suite asserts path construction, input-schema shape, JSON-vs-raw output, secret-handling guidance, and error mapping without ever calling the live API. A registry invariant test pins the exposed tool count and enforces unique names + well-formed schemas.

## Security

- Tokens never touch shell history (we use env vars, not CLI flags).
- Each tool maps 1:1 to a RareCloud API endpoint; the MCP server doesn't aggregate or transform data beyond what the API returns.
- Read-only scope — there is no path for an agent to mutate state via this server, even on a compromised token.
- The handful of tools that return live credentials (kubeconfigs, proxy endpoint lists) carry explicit secret-handling guidance so the agent doesn't echo them back unprompted.
- Revoke a token at any time: **Dashboard → Account → API tokens**. Revocation is instant, no propagation delay.

## License

MIT.
