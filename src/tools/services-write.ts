// Service write/action tools (Parity Phase B). The first mutating surface on
// this MCP server: everything here builds on the shared `writeTool` factory so
// input validation, the confirm gate, path encoding, and APIError handling stay
// uniform. More service-write tools land here in Tasks 2 & 3.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

export const setServiceHostname: ToolDefinition = writeTool({
  name: 'set_service_hostname',
  description:
    'Set the hostname of a service (cloud VM or legacy VPS). Requires scope services:write. ' +
    'The service_id comes from list_services; hostname is a valid DNS hostname (1–253 chars). ' +
    'Plain write — no billing impact, not destructive.',
  method: 'POST',
  input: z
    .object({
      service_id: z.string().min(1),
      hostname: z.string().min(1).max(253),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Service ID from list_services.' },
      hostname: { type: 'string', description: 'New hostname (valid DNS name, 1–253 chars).' },
    },
    required: ['service_id', 'hostname'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/hostname`,
  buildBody: (a) => ({ hostname: a.hostname }),
});
