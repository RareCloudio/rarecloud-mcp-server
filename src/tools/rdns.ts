// Reverse DNS READ tool (API: GET /v1/services/:id/rdns in
// api/src/routes/v1-services.ts). Cloud VMs only; the IP is always the VM's
// primary public IPv4, derived server-side (it can never be passed in). Scope
// services:read.

import { type ToolDefinition } from './types.js';
import { readTool, encodeSegment } from './factories.js';

export const getServiceRdns: ToolDefinition = readTool({
  name: 'get_service_rdns',
  description:
    `Get the reverse DNS (PTR) record of a cloud VM's primary public IPv4 address: the IP and the hostname ` +
    `it resolves back to. Mail servers check that this matches the VM's mail hostname. Requires scope ` +
    `services:read. Change it with set_service_rdns.`,
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', description: 'Cloud VM service_id from list_services.' },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/rdns`,
});
