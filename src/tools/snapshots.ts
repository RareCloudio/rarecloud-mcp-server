// VM snapshot READ tools (API: api/src/routes/v1-snapshots.ts). A snapshot is a
// copy-on-write clone of a cloud VM's root disk; it outlives the VM it came
// from, so it is addressed both on its own (/v1/snapshots[/:id]) and per VM
// (/v1/services/:id/snapshots). Snapshots are a cloud VM feature only: a legacy
// VPS id answers 404 (legacy VPS have list_backups instead). All scope
// services:read.

import { type ToolDefinition } from './types.js';
import { readList, readOne, readTool, encodeSegment } from './factories.js';

const SNAPSHOT_FIELDS =
  'Each snapshot has id, name, state (creating: no copy yet; securing: usable, still becoming ' +
  'independent of the VM disk; ready: fully independent; failed: see error), usedBytes (null until ' +
  'measured), sourceVmId, sourceVmName, minDiskGb, createdAt and error.';

export const listSnapshots: ToolDefinition = readList(
  'list_snapshots',
  '/v1/snapshots',
  `List every VM snapshot the account owns, across all cloud VMs (including snapshots whose VM was ` +
    `deleted). ${SNAPSHOT_FIELDS}`,
);

export const listServiceSnapshots: ToolDefinition = readTool({
  name: 'list_service_snapshots',
  description:
    `List the snapshots of one cloud VM (up to 5 per VM). Check this before a risky change: if there is ` +
    `no recent ready snapshot, take one with create_snapshot first. ${SNAPSHOT_FIELDS}`,
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Cloud VM service_id from list_services.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/snapshots`,
});

export const getSnapshot: ToolDefinition = readOne(
  'get_snapshot',
  '/v1/snapshots',
  `Get one VM snapshot: use it to poll a new snapshot until state is ready. ${SNAPSHOT_FIELDS}`,
  'id',
  { idSource: 'list_snapshots or list_service_snapshots' },
);
