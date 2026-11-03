// Outbound email (SMTP port 25) READ tool (API: GET /v1/services/:id/smtp in
// api/src/routes/v1-services.ts). Cloud VMs only. Scope services:read.

import { type ToolDefinition } from './types.js';
import { readTool, encodeSegment } from './factories.js';

export const getServiceSmtp: ToolDefinition = readTool({
  name: 'get_service_smtp',
  description:
    `Get the outbound email state of a cloud VM. Outbound email on TCP port 25 is blocked on new cloud ` +
    `servers; ports 465 and 587 (to a mail provider) and every other port stay open. Returns status: open ` +
    `(not restricted), blocked (restricted, no request yet), pending (a request is waiting for review), ` +
    `approved (port 25 is open) or rejected (the last request was declined); request, the latest unblock ` +
    `request or null (a rejected one carries the reason); and canRequestAfter, the time a new request is ` +
    `accepted again after a rejection or a revoked approval, otherwise null. Requires scope services:read. ` +
    `Ask for port 25 with request_smtp_unblock.`,
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Cloud VM service_id from list_services.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/smtp`,
});
