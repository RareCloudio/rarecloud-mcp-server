// Support-ticket WRITE tools (Parity Phase B, Task 8): open a ticket, reply to
// one, close one. Requires scope tickets:write. None is gated — a ticket is
// cheap and owner-scoped server-side (the adapter opens/replies under the
// authenticated user's WHMCS id, so there is no cross-user write surface).
//
// Everything builds on the shared `writeTool` factory. Bodies + bounds
// re-confirmed against console openapi.json AND the route source
// (api/src/routes/v1-tickets.ts).
//
// DEVIATIONS FROM BRIEF (reality wins — route + openapi agree):
//   - priority: the brief typed it `string`, but the route enforces a real enum
//     (z.enum(TICKET_PRIORITIES), pinned to Ticket['priority']) of low|medium|
//     high. Modeled as a zod + JSON Schema enum.
//   - attachments: the brief typed it `unknown[]`, but the route enforces a
//     STRUCTURED array (max 5) of { name, data } where data is base64-encoded
//     file content. Modeled as a bounded, closed { name, data } object schema.
//     We mirror the count/size BOUNDS (max 5 items; name 1-255; data 1-7,000,000)
//     but not the route's base64 / path-separator refinements (server-side
//     defenses re-validated on the API) — matching the infra-write "mirror
//     bounds, not server-internal refinements" precedent.
//
// reply_ticket / close_ticket carry a dynamic {id} path segment run through
// encodeSegment; close_ticket sends NO body (POST-with-no-body, like
// detach_reserved_ip). create_ticket has no path segment.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

const TICKET_PRIORITIES = ['low', 'medium', 'high'] as const;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_B64_CHARS = 7_000_000;

// Shared structured-attachment schema (base64 file uploads, max 5 per call).
const AttachmentSchema = z
  .object({
    name: z.string().min(1).max(255),
    data: z.string().min(1).max(MAX_ATTACHMENT_B64_CHARS),
  })
  .strict();

const ATTACHMENTS_JSON_SCHEMA = {
  type: 'array' as const,
  maxItems: MAX_ATTACHMENTS,
  description: 'Optional file uploads (max 5). Each item is {name, data} where data is base64-encoded content.',
  items: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255, description: 'File name (no path separators or null bytes).' },
      data: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ATTACHMENT_B64_CHARS,
        description: 'Base64-encoded file content (no data: URI prefix).',
      },
    },
    required: ['name', 'data'],
    additionalProperties: false,
  },
};

// --- create_ticket (POST /v1/tickets, no gate) -----------------------------

export const createTicket: ToolDefinition = writeTool({
  name: 'create_ticket',
  description:
    'Open a support ticket. Requires scope tickets:write. Plain write — not gated. subject (1-150); ' +
    'department is a department id from list_ticket_departments (1-64); priority is one of low | medium | ' +
    'high; body is the message (1-50000). attachments is an optional list (max 5) of {name, data} where ' +
    'data is base64-encoded file content.',
  method: 'POST',
  input: z
    .object({
      subject: z.string().min(1).max(150),
      department: z.string().min(1).max(64),
      priority: z.enum(TICKET_PRIORITIES),
      body: z.string().min(1).max(50_000),
      attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', minLength: 1, maxLength: 150, description: 'Ticket subject.' },
      department: { type: 'string', minLength: 1, maxLength: 64, description: 'Department id from list_ticket_departments.' },
      priority: { type: 'string', enum: [...TICKET_PRIORITIES], description: 'low | medium | high.' },
      body: { type: 'string', minLength: 1, maxLength: 50000, description: 'The message body.' },
      attachments: ATTACHMENTS_JSON_SCHEMA,
    },
    required: ['subject', 'department', 'priority', 'body'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/tickets',
  buildBody: (a) => {
    const body: Record<string, unknown> = {
      subject: a.subject,
      department: a.department,
      priority: a.priority,
      body: a.body,
    };
    if (a.attachments !== undefined) body.attachments = a.attachments;
    return body;
  },
});

// --- reply_ticket (POST /v1/tickets/{id}/replies, no gate) -----------------

export const replyTicket: ToolDefinition = writeTool({
  name: 'reply_ticket',
  description:
    'Post a reply to an existing support ticket. Requires scope tickets:write. Plain write — not gated. ' +
    'id comes from list_tickets; body is the reply text (1-50000). attachments is an optional list (max ' +
    '5) of {name, data} where data is base64-encoded file content.',
  method: 'POST',
  input: z
    .object({
      id: z.string().min(1),
      body: z.string().min(1).max(50_000),
      attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Ticket id from list_tickets.' },
      body: { type: 'string', minLength: 1, maxLength: 50000, description: 'The reply body.' },
      attachments: ATTACHMENTS_JSON_SCHEMA,
    },
    required: ['id', 'body'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/tickets/${encodeSegment(a.id, 'id')}/replies`,
  buildBody: (a) => {
    const body: Record<string, unknown> = { body: a.body };
    if (a.attachments !== undefined) body.attachments = a.attachments;
    return body;
  },
});

// --- close_ticket (POST /v1/tickets/{id}/close, no gate, no body) ----------

export const closeTicket: ToolDefinition = writeTool({
  name: 'close_ticket',
  description:
    'Close a support ticket. Requires scope tickets:write. Plain write — not gated. id comes from ' +
    'list_tickets. Returns the updated ticket.',
  method: 'POST',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Ticket id from list_tickets.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/tickets/${encodeSegment(a.id, 'id')}/close`,
});
