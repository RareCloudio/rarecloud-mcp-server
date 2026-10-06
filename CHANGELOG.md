# Changelog

All notable changes to `@rarecloudio/mcp-server` are recorded here.

## Unreleased

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
