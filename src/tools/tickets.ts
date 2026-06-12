// Support ticket tools — read-only. Opening / replying to tickets stays manual
// until the write-tool (plan-then-approve) flow ships.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';

export const listTickets: ToolDefinition = {
  name: 'list_tickets',
  description: 'List support tickets for the authenticated account: id, subject, status (open / awaiting-staff / awaiting-client / closed), department, last-updated. Use for "do I have any open tickets?".',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['open', 'awaiting-staff', 'awaiting-client', 'closed'],
        description: 'Optional filter on ticket status.',
      },
    },
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const data = await client.get('/v1/tickets', {
        status: args.status as string | undefined,
      });
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getTicket: ToolDefinition = {
  name: 'get_ticket',
  description: 'Get a single support ticket with its full message thread. Use after list_tickets to read the conversation or check the latest staff reply.',
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: {
        type: 'string',
        description: 'Ticket ID from list_tickets.',
      },
    },
    required: ['ticket_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      const id = args.ticket_id as string;
      const data = await client.get(`/v1/tickets/${encodeURIComponent(id)}`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};
