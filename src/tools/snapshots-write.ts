// VM snapshot WRITE tools (API: api/src/routes/v1-snapshots.ts): take, delete
// and restore. All scope services:write, all on the shared writeTool factory.
//
// create_snapshot is `spends` (a snapshot is billed for the storage it uses
// until it is deleted) and idempotent (POST /v1/services/:id/snapshots is in
// idempotency.ts). delete_snapshot is `destructive` (it may be the only copy).
// restore_snapshot is `destructive`: it REPLACES the VM's root disk, and
// everything written since the snapshot is lost. POST /v1/services/:id/restore
// is NOT an idempotent route, so it takes no idempotency_key.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const createSnapshot: ToolDefinition = writeTool({
  name: 'create_snapshot',
  description:
    `Take a snapshot of a cloud VM's root disk. Requires scope services:write. Take one BEFORE any risky ` +
    `change (reinstall_service, resize_service, an OS upgrade, a big config change): restore_snapshot is ` +
    `the undo. service_id is the cloud VM; name is 1-64 chars. The VM keeps running. Returns as soon as ` +
    `the snapshot is recorded; it is usable within seconds and reaches state ready once fully independent ` +
    `(poll get_snapshot). Up to 5 snapshots per VM: delete an old one with delete_snapshot to make room.`,
  method: 'POST',
  idempotent: true,
  safety: {
    kind: 'spends',
    reason: 'creates a snapshot billed for the storage it uses until it is deleted',
  },
  input: z.object({ service_id: z.string().min(1), name: z.string().trim().min(1).max(64) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Cloud VM service_id from list_services.' },
      name: { type: 'string', minLength: 1, maxLength: 64, description: 'Snapshot name (1-64 chars), e.g. "before-upgrade".' },
    },
    required: ['service_id', 'name'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/snapshots`,
  buildBody: (a) => ({ name: a.name }),
});

export const deleteSnapshot: ToolDefinition = writeTool({
  name: 'delete_snapshot',
  description:
    `Delete a VM snapshot. Requires scope services:write. id comes from list_snapshots or ` +
    `list_service_snapshots. Refused (409) while VMs created from this snapshot still exist; the error ` +
    `names them.`,
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason: 'permanently deletes the snapshot, which may be the only copy of that disk state',
  },
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Snapshot id from list_snapshots or list_service_snapshots.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/snapshots/${encodeSegment(a.id, 'id')}`,
});

export const restoreSnapshot: ToolDefinition = writeTool({
  name: 'restore_snapshot',
  description:
    `Restore a cloud VM from one of its own snapshots: the undo for a change that went wrong. Requires ` +
    `scope services:write. service_id is the cloud VM; snapshotId must be a snapshot taken from that same ` +
    `VM (list_service_snapshots). The VM's root disk is replaced by the snapshot's contents. Returns ` +
    `{ status: "restoring", serverId } once the rebuild is accepted, not when it is finished; poll ` +
    `get_service. If the current disk state may still be wanted, take a fresh snapshot with ` +
    `create_snapshot first.`,
  method: 'POST',
  safety: {
    kind: 'destructive',
    reason: "replaces the VM's root disk with the snapshot; everything written to the VM since that snapshot is lost",
  },
  input: z
    .object({
      service_id: z.string().min(1),
      snapshotId: z.string().regex(UUID_RE, 'snapshotId must be a snapshot id (UUID)'),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Cloud VM service_id from list_services.' },
      snapshotId: {
        type: 'string',
        pattern: UUID_PATTERN,
        description: 'Snapshot id (UUID) from list_service_snapshots, taken from this same VM.',
      },
    },
    required: ['service_id', 'snapshotId'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/restore`,
  buildBody: (a) => ({ snapshotId: a.snapshotId }),
});
