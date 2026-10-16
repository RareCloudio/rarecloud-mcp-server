// Cloud quota READ tools (API: api/src/routes/v1-limits.ts). Strictly
// self-scoped: no id anywhere. All scope services:read.
//
// get_quota_limits is the newer GET /v1/limits (effective OpenStack quotas
// with live usage, plus registry and sandboxes figures); get_account_limits
// stays on the older /v1/account/limits counters. estimate_limits is a POST
// that creates and reserves nothing, so it is a READ tool (read annotations,
// no confirm gate, no idempotency_key), like check_order.

import { z } from 'zod';
import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';
import { readList, defineReadTool, formatZodError } from './factories.js';

export const getQuotaLimits: ToolDefinition = readList(
  'get_quota_limits',
  '/v1/limits',
  `Get the account's effective cloud quotas with live usage: one row per resource (cores, ram, ` +
    `instances, volumes, gigabytes, floatingip, ...) with used, limit (-1 = unlimited), state (ok | warn | ` +
    `danger | unknown) and ratio, plus registry and sandboxes figures (null when not in use). A row with ` +
    `unavailable=true means usage could not be read: unknown, not zero. Use it before planning a deploy or ` +
    `a resize; if a resource is short, ask for more with request_quota_increase. Requires scope services:read.`,
);

const EstimatePool = z
  .object({
    name: z.string().trim().max(63).optional(),
    machineType: z.string().trim().min(1).max(80),
    minimum: z.number().int().min(1).max(16),
    maximum: z.number().int().min(1).max(16),
    volumeSizeGb: z.number().int().min(1).max(16384).optional(),
  })
  .strict()
  .refine((p) => p.maximum >= p.minimum, 'maximum must be at least the minimum');

const estimateInput = z.object({ pools: z.array(EstimatePool).min(1).max(5) }).strict();

export const estimateLimits: ToolDefinition = defineReadTool({
  name: 'estimate_limits',
  description:
    `Pre-flight a managed Kubernetes deployment against the account's quotas and live usage, without ` +
    `creating or reserving anything. Requires scope services:read. Takes the worker pools (1-5, each ` +
    `machineType plus minimum and maximum node counts 1-16). Answers whether the pools' MINIMUMS fit in ` +
    `what is left of the quota (blocking: a deploy cannot start without them) and how far each pool can ` +
    `actually scale toward its maximum (advisory). available=false means a machine type has no catalog ` +
    `plan: treat it as unknown, not as "does not fit". If it does not fit, ask for more with ` +
    `request_quota_increase.`,
  inputSchema: {
    type: 'object',
    properties: {
      pools: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        description: 'Worker pools to estimate (1-5).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 63, description: 'Optional pool name (defaults to pool-N).' },
            machineType: { type: 'string', minLength: 1, maxLength: 80, description: 'Machine type, e.g. g-8vcpu-32gb.' },
            minimum: { type: 'integer', minimum: 1, maximum: 16, description: 'Minimum node count (1-16).' },
            maximum: { type: 'integer', minimum: 1, maximum: 16, description: 'Maximum node count (1-16, at least minimum).' },
            volumeSizeGb: { type: 'integer', minimum: 1, maximum: 16384, description: "Optional root-disk size in GB; omit to use the machine type's own disk." },
          },
          required: ['machineType', 'minimum', 'maximum'],
          additionalProperties: false,
        },
      },
    },
    required: ['pools'],
    additionalProperties: false,
  },
  async handler(client, args) {
    const parsed = estimateInput.safeParse(args);
    if (!parsed.success) {
      return errorResult(`Invalid input for estimate_limits: ${formatZodError(parsed.error)}`);
    }
    try {
      return jsonResult(await client.post('/v1/limits/estimate', parsed.data));
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
});

export const listQuotaRequests: ToolDefinition = readList(
  'list_quota_requests',
  '/v1/limits/requests',
  `List the account's quota-increase requests, newest first: requested ceilings, reason, and status ` +
    `(pending | approved | auto_approved | denied). Requires scope services:read.`,
);
