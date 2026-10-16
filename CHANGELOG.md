# Changelog

All notable changes to `@rarecloudio/mcp-server` are recorded here.

## Unreleased

Totals with every entry below: 222 tools, 110 reads, 112 writes (85 gated,
27 plain), 46 take `idempotency_key`.

### Added: Container Registry tools

20 tools for the private OCI registry (`/v1/registry*`), all under
`services:read` / `services:write` (there is no separate registry scope).
Until the registry launches every registry write answers `503
BACKEND_UNAVAILABLE` and changes nothing; each write's description says so.

- Reads: `get_registry` (usage is the hourly metering sample; `push.reason`
  explains a refusal, including the repository cap `repo_limit`, which counts
  the repository index), `list_registry_tiers`, `suggest_registry_handle`,
  `list_registry_credentials` (optional `status: "active"`),
  `list_registry_repositories` (`lastPush` is the newest image's build time),
  `get_registry_repository` (`createdAt` is the build time; `pushedAt` is a
  deprecated alias of it), `list_registry_tag_vulnerabilities`,
  `list_registry_clusters`.
- Writes: `enable_registry` and `set_registry_tier` (spends),
  `close_registry`, `revoke_registry_credential`, `delete_registry_repository`
  (an empty repository answers `deleted: 0`), `delete_registry_tag` (404 for a
  missing tag), `delete_registry_manifest` (by digest; `confirm_multiple_tags`
  sends the API's `confirm=true`, without which a digest more than one tag
  points at answers 409), `unlink_registry_cluster` (destructive),
  `rotate_registry_cluster_link` (disruptive), `create_registry_credential`,
  `create_registry_kubernetes_manifest` and `link_registry_cluster` (sensitive; the
  first two return a live secret once).
- `enable_registry`, `create_registry_credential` and `link_registry_cluster`
  take `idempotency_key`.
- The client treats an empty 2xx body (a bare 204) as a success instead of
  `INVALID_RESPONSE`, and `post()` takes an optional `headers` overlay (used to
  ask the Kubernetes manifest endpoint for JSON).

### Changed: Private network firewall and load balancer members

- `list_firewalls` / `get_firewall` describe `isPrivateNetwork` and
  `remoteFirewallId`; `list_firewalls` no longer mentions a status field.
- `attach_firewall`, `detach_firewall` and `delete_firewall` say the Private
  network firewall answers 409; `add_firewall_rule` says an inbound rule on it
  needs a private source range (400 otherwise) and that `rarecloud:`
  descriptions are reserved.
- `create_load_balancer` caps `memberServerIds` at 50 (as the API does) and
  describes the managed rule on the Private network firewall.
- `add_load_balancer_member` / `remove_load_balancer_member` describe the 409
  while a load balancer is being set up or deleted and the two kinds of 503.

### Added: proxy extras (6 tools)

Six proxy tools:

- Reads (scope `services:read`): `get_proxy_bandwidth`
  (`GET /v1/proxies/{id}/bandwidth`, GB Residential only),
  `list_proxy_replacement_locations`
  (`GET /v1/proxies/{id}/replacements/locations`, ISP only),
  `get_proxy_auto_rotation` (`GET /v1/proxies/{id}/auto-rotation`, mobile
  only), and `check_proxy` (`POST /v1/proxies/{id}/check`). `check_proxy` is a
  POST but a read tool: the API scopes it `services:read`, exempts it from
  Idempotency-Key as a read-only check. Its description says it sends a small
  amount of traffic through each proxy and refreshes the location the API
  shows for the service.
- Writes (scope `services:write`, both **disruptive** and gated, mobile only):
  `set_proxy_auto_rotation` (`PUT /v1/proxies/{id}/auto-rotation`, `enabled`
  plus `intervalMinutes` 5 to 1440, both required) and `rotate_proxy`
  (`POST /v1/proxies/{id}/rotate`, no body, no `idempotency_key` because the
  API exempts the route).
- `request_proxy_replacement` takes optional `locationId` (min 1 char) and
  `locationLabel` (1 to 120 chars), as the API route accepts them: pick a
  location from `list_proxy_replacement_locations` to move the new IP there.
  Without them the request has no body, as before.

### Added: AI Sandboxes tools

Ten tools for AI Sandboxes (`/v1/sandboxes`), five of them reads:

- Reads (scope `services:read`): `list_sandboxes` (`GET /v1/sandboxes`),
  `get_sandbox` (`GET /v1/sandboxes/{id}`), `list_sandbox_templates`
  (`GET /v1/sandboxes/templates`, size and hourly price), `read_sandbox_file`
  (`GET /v1/sandboxes/{id}/files?path=`), and `get_sandbox_logs`
  (`GET /v1/sandboxes/{id}/logs?tail=`, plain text returned verbatim; a 503
  passes the API message through and says logs are not available yet, a 404
  says the logs are gone).
- Writes (scope `services:write`): `create_sandbox` (`POST /v1/sandboxes`,
  **spends**, gated, takes `idempotency_key`; template, image, timeoutMs, name,
  env, labels, networkBlocked and run mode with entrypoint/command; env values
  are marked as secret input, refused entries are named by position, and an
  `env` field is stripped from the result), `delete_sandbox`
  (`DELETE /v1/sandboxes/{id}`, **destructive**, gated), and the plain
  `run_sandbox_code` (`POST /run_code`), `run_sandbox_command`
  (`POST /commands`) and `write_sandbox_file` (`PUT /files`).
- No tool for `POST /v1/sandboxes/{id}/ports/{port}`: the API answers 501 by
  product decision.
- `RareCloudClient.getText` reads a plain-text endpoint; an error still maps to
  the usual `APIError` with its HTTP status.

### Added: snapshots, quotas and reverse DNS (13 tools)

- VM snapshots: `list_snapshots`, `list_service_snapshots`, `get_snapshot`
  (reads); `create_snapshot` (spends, takes `idempotency_key`),
  `delete_snapshot` and `restore_snapshot` (destructive; restore replaces the
  root disk). The descriptions tell an agent to snapshot before
  `reinstall_service` or `resize_service` and that `restore_snapshot` is the
  undo; those two tools now say so too.
- Quotas: `get_quota_limits` (`GET /v1/limits`, effective limits with live
  usage), `estimate_limits` (read, `POST /v1/limits/estimate`, creates and
  reserves nothing), `list_quota_requests`, and `request_quota_increase`
  (sensitive like `create_ticket`: a large request opens a support ticket in
  the user's name and replaces any pending one; takes `idempotency_key`).
- Reverse DNS: `get_service_rdns`; `set_service_rdns` and
  `delete_service_rdns` (disruptive, like `set_domain_dns`).

## 0.3.0 (2026-10-08)

### Changed

- Descriptions for asynchronous load balancer create and delete, partial lists,
  hibernated clusters, deployable images only: `create_load_balancer` (returns
  `pending`, poll until `active`, never retry create), `delete_load_balancer`
  (`deleted` or `deleting`), `deploy_service` and `destroy_service` (load
  balancer results), `list_services` (X-Partial-Results), `get_service` and
  `list_services` (status vocabulary), `list_images` (deployable only).
- `list_services` puts a first text block "Note: partial results, missing:
  cloud-vm" in the result when the API sends an `X-Partial-Results` header;
  `RareCloudClient.get` takes an optional `meta` object that receives it.

### Added: `check_order`

- `check_order` (read, `POST /v1/services/preflight`, scope `services:write`):
  would `deploy_service` be accepted for this account right now? It takes the
  same body as `deploy_service` (without `confirm` and `idempotency_key`),
  validated by the same per-category rules, and creates or reserves nothing.
  The answer is `{ allowed, reason, neededCents?, availableCents?,
  missingCents?, currency?, addFundsUrl?, invoiceId?, payInvoiceUrl?, message?
  }`; when `allowed` is false the agent shows the human the message and the
  Add funds or Pay invoice link, since an agent cannot pay. `checked_at_order`
  means a VPS, hosting, proxy or domain order is checked by billing only when
  it is placed. It is a POST that changes nothing, so it carries the read
  annotations, no confirm gate and no idempotency key. `deploy_service`'s
  description now says to call it first. 173 tools, 86 of them reads.

### Fixed: `deploy_service` refused load balancers, volumes and networks

`deploy_service` required `productId` (or `plan`) for every body, so
`category: cloud-loadbalancer`, `cloud-volume` and `cloud-network`, which the
API creates without a catalog SKU, were refused before any request ("productId
(or its alias plan) is required"). The requirement is now per category, as the
API has it: `cloud-loadbalancer` needs `memberServerIds` (at least one VM;
`port` defaults to 80, `name` to "load-balancer"), `cloud-volume` needs
`sizeGb` (1 to 2048), `cloud-network` needs `name` (or `hostname`) with at least
one letter or digit, and every other category, or a body with no category,
needs `productId` (or `plan`). `port` (1 to 65535) and `sizeGb` (1 to 2048) are
bounded in both the zod input and the advertised schema, and `port`,
`memberServerIds`, `healthCheck`, `sizeGb` and `name` now describe what each
family needs.

### Added: safe retries with idempotency keys

The 40 write tools that map to a POST route where the API honours an
`Idempotency-Key` now take an optional `idempotency_key` input (1 to 255
printable ASCII characters; reuse the same value if you retry this exact
request). It is sent as the `Idempotency-Key` header, so the API runs the
request at most once per key. Without it the server makes one UUIDv4 key per
call and retries once, with that key, when the connection drops or times out
(a gateway 502/503/504 page counts as a dropped answer). `409
IDEMPOTENCY_IN_PROGRESS` is waited out (`Retry-After`, capped at 10 seconds, at
most 3 times); `422 IDEMPOTENCY_KEY_REUSED` and every other error are final. A
replayed answer starts with a note that says so and passes on
`secretsOmittedOnReplay`. The confirm gate still runs first. The header and the
retry live in the client, once, and are never used on any other POST. Tools:
`add_account_ssh_key`, `add_cluster_pool`, `add_firewall_rule`,
`add_load_balancer_member`, `add_proxy_whitelisted_ip`, `add_service_ssh_key`,
`add_service_ssh_key_to_library`, `cancel_service`, `create_bucket`,
`create_cluster_kubeconfig`, `create_firewall`, `create_load_balancer`,
`create_network`, `create_object_storage_key`, `create_proxy_request`,
`create_service_backup`, `create_ticket`, `create_volume`, `deploy_service`,
`enable_cluster_ha`, `enable_object_storage`, `manage_account_contact`,
`order_proxy`, `reboot_service`, `redeem_voucher`, `register_domain`,
`reinstall_service`, `renew_domain`, `renew_proxy`, `renew_service`,
`reply_ticket`, `request_proxy_replacement`, `reserve_ip`,
`reset_service_password`, `resize_service`, `set_cluster_scale`,
`start_service`, `stop_service`, `transfer_domain`, `upgrade_service`.

### Added: resources the user made read-only for agents

- `list_api_access` (read, `GET /v1/api-access`): the services and domains the
  user made read-only for agents and API tokens, to check before planning
  changes.
- A `403 RESOURCE_PROTECTED` refusal is turned, in one place, into an error that
  tells the agent the user made the resource read-only, that it must not retry
  or work around it, and to ask the user to turn API access on in the console at
  the link the API gives, if the change is really wanted.
- The switch endpoints (`PUT /v1/services/{id}/api-access`,
  `PUT /v1/domains/{id}/api-access`) have no tool: only a console session can
  change API access. The registry exclusion test pins it.

### Added: `set_service_tags`

`set_service_tags` (plain, `PUT /v1/services/{id}/tags`) replaces a cloud VM's
whole tag set; `[]` clears it. At most 50 tags, each 1 to 60 characters, no
comma, slash or control character, and no tag starting with `managed:`, `k8s:`
or `rarecloud` (any case).

### Changed

- `deploy_service`: `tags` (cloud VM) now enforces the same tag limits.
- `list_services`, `get_service`, `list_domains`, `get_domain` describe the
  `apiAccess` field (`"full"` or `"read_only"`, missing means full);
  `get_service` also describes a cloud VM's `tags` and `bandwidthUsage`
  (`usedGb`, `includedGb`, `periodStart`, `measuredThrough`, present while
  egress metering is on).
- The server now exposes 172 tools: 85 reads and 87 writes, 63 of them gated.

### Added: Object Storage tools

Object Storage (S3-compatible buckets with optional CDN delivery) had no MCP
coverage. 14 new tools cover every customer route under `/v1/object-storage`
(scopes `services:read` / `services:write`):

- Reads: `get_object_storage`, `list_object_storage_regions`,
  `get_object_storage_usage`, `list_buckets`, `get_bucket`, `get_bucket_usage`,
  `list_object_storage_keys`.
- Writes, all gated: `enable_object_storage` (spends), `create_bucket`
  (spends: the first bucket starts the base fee), `update_bucket` (sensitive:
  `public:true` makes every object readable by anyone over the CDN),
  `delete_bucket` (destructive), `disable_object_storage` (destructive),
  `create_object_storage_key` (sensitive, returns the secret access key once,
  marked with the SECURITY sentence), `delete_object_storage_key`
  (destructive).

The server now exposes 170 tools: 84 reads and 86 writes, 63 of them gated.

### BREAKING: 23 more write tools now require `confirm: true`

These tools ran without confirmation in 0.2.0. They now refuse, making no API
call, unless the call passes `confirm: true`. A caller that invokes them without
it gets an error that says what the tool would have done; re-call with
`confirm: true` once the user has approved.

- **disruptive** (interrupts something running or locks someone out):
  `stop_service`, `reboot_service`, `detach_volume`, `detach_firewall`,
  `detach_reserved_ip`, `set_domain_nameservers`, `set_domain_dns`,
  `set_proxy_credentials`, `set_proxy_auth_method`, `request_proxy_replacement`,
  `apply_service_ssh_key_library`, `set_cluster_scale`, `update_cluster_pool`,
  `rename_cluster_pool` (it replaces every worker node in the pool),
  `attach_network_vm` (it cuts the VM's existing private connections)
- **sensitive** (grants access, changes ownership or legal data, or speaks for
  the user): `set_domain_contacts`, `manage_domain`, `create_cluster_kubeconfig`,
  `add_service_ssh_key`, `create_ticket`, `reply_ticket`, `update_account`,
  `manage_account_contact`

### Safety model

- Every write tool now has exactly one safety kind: plain, spends, destructive,
  disruptive or sensitive. The confirm gate, the refusal message, the `confirm`
  parameter description, a standard trailing `Safety:` sentence in the
  description, and the MCP annotations are all derived from it in the
  `writeTool` factory. 56 write tools are gated, 23 are plain.
- The refusal message and the `confirm` description now name the tool-specific
  consequence instead of the generic "spends from your account balance and/or is
  irreversible" text.
- Every tool now carries MCP annotations. All 77 read tools set
  `readOnlyHint: true` (plus `idempotentHint: true`, `destructiveHint: false`,
  `openWorldHint: true`), so clients can auto-approve reads. All write tools set
  `readOnlyHint: false` and `openWorldHint: true`; `destructiveHint` is true for
  destructive and disruptive tools. In 0.2.0 only 19 tools had annotations and
  the 14 money-spending tools had none.
- `set_service_password` and `reset_service_password` are classified disruptive
  (they were marked destructive); they stay gated.
- Removed the hand-written and partly false safety phrases ("Plain write, not
  destructive", "not gated", "not exposed as an MCP tool") from the
  descriptions. `stop_service`, for example, claimed to be "not destructive".

### Secret handling

- Tools whose result contains a live credential carry one standard SECURITY
  sentence: `deploy_service` (one-time console password), `reinstall_service`
  (one-time console password), `order_proxy` (an ISP plan's proxy list),
  `create_cluster_kubeconfig`, `get_cluster_kubeconfig`,
  `download_cluster_kubeconfig`, `get_proxy_list`, `get_proxy_auth`,
  `get_proxy_request_list`. `deploy_service` and `order_proxy` had no guidance
  before.
- Tools that take a secret as input (`set_service_password`,
  `reset_service_password`, `set_proxy_credentials`) tell the agent never to echo
  the value back.

### Descriptions

- `list_os_templates` no longer claims the reinstall is not exposed; it points at
  `reinstall_service`, and covers cloud VMs as well as legacy VPS.
- `get_provisioning_state` documents legacy VPS ids and cloud VM ids (UUID).
- `set_service_hostname` documents that for a cloud VM it renames the server; the
  hostname inside the running OS is not changed.
- Every `serverId` parameter now says it is the same value as the cloud VM
  `service_id` from `list_services`, and id parameters name the list tool they
  come from.
- Read tools that pointed at writes "not exposed yet" now name the write tool.
- Proxy credential and whitelist tools document that they work for ISP and GB
  Residential services, not ISP only.

### README

- Fixed the `claude mcp add` example (`-e` goes before `--`).
- Node.js requirement is 21+, matching `engines`.
- New "Safety model" section; the write-tool table lists each tool's kind.
