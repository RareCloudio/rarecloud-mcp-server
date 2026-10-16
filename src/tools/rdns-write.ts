// Reverse DNS WRITE tools (API: PUT/DELETE /v1/services/:id/rdns in
// api/src/routes/v1-services.ts). Scope services:write. The request never names
// an IP: the API derives the VM's primary public IPv4 server-side.
//
// Both are `disruptive` (gated, destructiveHint): the PTR record is live DNS
// that other mail servers check, so a wrong or missing name can get the VM's
// mail rejected, but it is reversible by setting the record again (the same
// classification as set_domain_dns).

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

const SERVICE_ID = { type: 'string', minLength: 1, description: 'Cloud VM service_id from list_services.' } as const;

export const setServiceRdns: ToolDefinition = writeTool({
  name: 'set_service_rdns',
  description:
    `Set the reverse DNS (PTR) record of a cloud VM's primary public IPv4 address, e.g. mail.example.com ` +
    `for a mail server. Requires scope services:write. service_id is the cloud VM; hostname is 1-254 chars ` +
    `and should also resolve forward (A record) to the VM's IP. Replaces any existing record. Returns the ` +
    `ip and hostname.`,
  method: 'PUT',
  safety: {
    kind: 'disruptive',
    reason: "replaces the reverse DNS record of the VM's public IP; mail servers that check it see the new name, and a wrong one can get the VM's mail rejected",
  },
  input: z.object({ service_id: z.string().min(1), hostname: z.string().trim().min(1).max(254) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { ...SERVICE_ID },
      hostname: { type: 'string', minLength: 1, maxLength: 254, description: 'Hostname the IP should resolve back to, e.g. mail.example.com.' },
    },
    required: ['service_id', 'hostname'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/rdns`,
  buildBody: (a) => ({ hostname: a.hostname }),
});

export const deleteServiceRdns: ToolDefinition = writeTool({
  name: 'delete_service_rdns',
  description:
    `Remove the reverse DNS (PTR) record of a cloud VM's primary public IPv4 address. Requires scope ` +
    `services:write. service_id is the cloud VM.`,
  method: 'DELETE',
  safety: {
    kind: 'disruptive',
    reason: "removes the reverse DNS record of the VM's public IP; mail servers that check it may reject the VM's mail until a record is set again",
  },
  input: z.object({ service_id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { service_id: { ...SERVICE_ID } },
    required: ['service_id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/rdns`,
});
