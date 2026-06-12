# @rarecloudio/mcp-server

Model Context Protocol server for the [RareCloud](https://rarecloud.io) API.

Drop into [Claude Code](https://claude.com/claude-code), Claude Desktop, [Cursor](https://cursor.com), or your own MCP client to let AI agents inspect and reason about your RareCloud account — list servers, browse the catalog, check billing, plan deployments.

## What it does

Exposes **20 read-only tools** wrapping the RareCloud REST API:

| Category | Tool | Purpose |
|---|---|---|
| Catalog | `list_catalog_products` | Browse orderable plans, filter by kind/backend |
| | `get_catalog_plan` | Full plan detail: specs + pricing + billing tracks |
| | `list_regions` | Available datacenter regions |
| | `list_images` | OS images (Ubuntu / Debian / Windows / ...) |
| Services | `list_services` | All your running services (filter by category) |
| | `get_service` | Detail on one service |
| | `get_service_metrics` | CPU / RAM / disk / bandwidth time series |
| | `list_backups` | Backups for one legacy VPS |
| | `get_provisioning_state` | Setup state of a pending service (paid / unprovisioned / stuck) |
| | `list_os_templates` | OS templates a legacy VPS can be reinstalled with |
| | `list_upgrade_options` | Plans+cycles a service could upgrade/downgrade to |
| Billing | `list_invoices` | Invoice history |
| | `get_invoice` | Detail on one invoice |
| | `get_credit_balance` | Current prepaid credit |
| | `get_credit_ledger` | Credit movements (top-ups, vouchers, metering) |
| Support | `list_tickets` | Support tickets (filter by status) |
| | `get_ticket` | One ticket with its full thread |
| Account | `get_account` | Profile (email, name, country) |
| | `list_ssh_keys` | SSH keys on a server (per-service) |
| | `get_account_limits` | Resource caps + current usage |

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

Get an API token: **Dashboard → Account → API tokens → New token**. Scope it to read-only (`services:read`, `billing:read`, `account:read`, `catalog:read`). Copy it — shown once.

Set the env var:

```bash
export RARECLOUD_API_TOKEN="rc_pat_..."
```

Optional, for self-hosted / staging instances:

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

Restart Claude Desktop. The 20 tools become available under the 🔌 menu.

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
      "args": ["/absolute/path/to/rarecloud-io/mcp-server/dist/index.js"],
      "env": { "RARECLOUD_API_TOKEN": "rc_pat_..." }
    }
  }
}
```

## Security

- Tokens never touch shell history (we use env vars, not CLI flags).
- Each tool maps 1:1 to a RareCloud API endpoint; the MCP server doesn't aggregate or transform data beyond what the API returns.
- Read-only scope — there is no path for an agent to mutate state via this server, even on a compromised token.
- Revoke a token at any time: **Dashboard → Account → API tokens**. Revocation is instant, no propagation delay.

## License

MIT.
