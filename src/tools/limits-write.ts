// Cloud quota WRITE tool (API: POST /v1/limits/requests in
// api/src/routes/v1-limits.ts). Scope services:write.
//
// Safety: `sensitive`, by analogy with create_ticket. Asking for more quota
// charges nothing, but a request larger than the auto-approve ceiling opens a
// support ticket in the user's name that staff act on, and submitting again
// replaces the user's pending request. That is the same "speaks for the user to
// RareCloud staff" consequence create_ticket and reply_ticket are gated for, so
// the agent must surface the request to the user first. The route is in
// idempotency.ts, so the tool takes idempotency_key.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool } from './factories.js';

// The API's REQUESTABLE list (api/src/routes/v1-limits.ts).
const OPENSTACK_RESOURCES = ['cores', 'ram', 'instances', 'volumes', 'gigabytes', 'floatingip'] as const;

const ceiling = z
  .number()
  .int()
  .refine((n) => n === -1 || n > 0, 'must be a positive number, or -1 for unlimited');

const requestedSchema = z
  .object({
    cores: ceiling.optional(),
    ram: ceiling.optional(),
    instances: ceiling.optional(),
    volumes: ceiling.optional(),
    gigabytes: ceiling.optional(),
    floatingip: ceiling.optional(),
    object_storage_tb: z.number().int().min(1).max(1000).optional(),
    sandboxes: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'request at least one resource');

const CEILING_JSON = {
  type: 'integer',
  minimum: -1,
  description: 'New ceiling: a positive number, or -1 for unlimited (0 is refused).',
} as const;

export const requestQuotaIncrease: ToolDefinition = writeTool({
  name: 'request_quota_increase',
  description:
    `Ask for a higher cloud quota. Requires scope services:write. requested maps each resource to its new ` +
    `ceiling (must exceed the current limit from get_quota_limits): ${OPENSTACK_RESOURCES.join(', ')} take a ` +
    `positive number or -1 for unlimited; object_storage_tb takes 1-1000; sandboxes takes 1-200. reason ` +
    `(10-2000 chars) is what a human reviewer reads, so say what is being deployed. context is an optional ` +
    `object such as {kind: "k8s", name: "prod"} (4096 bytes max). Modest increases are applied at once ` +
    `(status auto_approved) when the region has headroom; larger ones stay pending and open a support ` +
    `ticket. Only one pending request exists at a time: submitting again replaces it. Check progress with ` +
    `list_quota_requests.`,
  method: 'POST',
  idempotent: true,
  safety: {
    kind: 'sensitive',
    reason:
      "submits a quota request on the user's behalf; a large one opens a support ticket that RareCloud staff act on, and it replaces any pending request",
  },
  input: z
    .object({
      requested: requestedSchema,
      reason: z.string().trim().min(10).max(2000),
      context: z
        .object({ kind: z.string().max(40), name: z.string().max(200).optional() })
        .passthrough()
        .refine((o) => JSON.stringify(o).length <= 4096, 'context is too large (4096 bytes max)')
        .optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      requested: {
        type: 'object',
        minProperties: 1,
        description: 'New ceiling per resource; name at least one.',
        properties: {
          ...Object.fromEntries(OPENSTACK_RESOURCES.map((r) => [r, { ...CEILING_JSON }])),
          object_storage_tb: { type: 'integer', minimum: 1, maximum: 1000, description: 'Object storage hard quota in whole TB (1-1000).' },
          sandboxes: { type: 'integer', minimum: 1, maximum: 200, description: 'How many AI sandboxes may run at once (1-200; auto-approved up to 16).' },
        },
        additionalProperties: false,
      },
      reason: { type: 'string', minLength: 10, maxLength: 2000, description: 'Why the increase is needed (10-2000 chars).' },
      context: {
        type: 'object',
        description: 'Optional: what prompted this, e.g. {kind: "k8s", name: "prod"} (kind max 40 chars, name max 200, 4096 bytes in all).',
        properties: {
          kind: { type: 'string', maxLength: 40 },
          name: { type: 'string', maxLength: 200 },
        },
        required: ['kind'],
        additionalProperties: true,
      },
    },
    required: ['requested', 'reason'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/limits/requests',
  buildBody: (a) => {
    const body: Record<string, unknown> = { requested: a.requested, reason: a.reason };
    if (a.context !== undefined) body.context = a.context;
    return body;
  },
});
