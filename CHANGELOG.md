# Changelog

All notable changes to `@rarecloudio/mcp-server` are recorded here.

## Unreleased

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
