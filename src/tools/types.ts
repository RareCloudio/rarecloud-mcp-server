// Each MCP tool: a JSON Schema for inputs + a handler that returns the
// shape MCP expects (`content` array, each block typed).
//
// We keep handlers small and uniform — they always return either a JSON
// payload or a friendly error message. The actual HTTP work lives in
// client.ts. Tool descriptions are tuned for LLM consumption: lead with
// the verb, mention the resource, hint at when to use it.

import type { RareCloudClient } from '../client.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (
    client: RareCloudClient,
    args: Record<string, unknown>,
  ) => Promise<ToolCallResult>;
}

export interface ToolCallResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }
  >;
  isError?: boolean;
}

// Helper: wrap JSON in a text block (the de-facto MCP convention until
// structured outputs land in the spec).
export function jsonResult(data: unknown): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string): ToolCallResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
