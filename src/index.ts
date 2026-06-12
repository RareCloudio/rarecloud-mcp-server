#!/usr/bin/env node
// MCP server for RareCloud — exposes a read-only tool surface that lets
// AI agents (Claude Code, Claude Desktop, Cursor, custom agents) inspect
// a RareCloud account and reason about it.
//
// Design notes:
//   - READ-ONLY by design. No create / destroy / mutate tools yet.
//     Mutating actions need the derived-token + plan-and-approve flow
//     described in docs/ideas/2026-05-22-agent-ai-architecture.md.
//     Until that ships, the agent suggests and the user confirms in
//     dashboard / CLI / Terraform.
//   - Authenticates with a personal access token (Dashboard → Account →
//     API tokens). Scope the token to *:read for safety.
//   - Speaks stdio. To use with Claude Desktop, see README.md for the
//     mcpServers config snippet.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { clientFromEnv, APIError } from './client.js';
import { TOOLS, findTool } from './tools/index.js';

const SERVER_NAME = 'rarecloud';
const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  // Validate config early so the user sees a clear error instead of
  // every tool call failing with the same MISSING_TOKEN.
  try {
    clientFromEnv();
  } catch (e) {
    process.stderr.write(`${(e as APIError).message}\n`);
    process.exit(1);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findTool(req.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const client = clientFromEnv();
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await tool.handler(client, args);
    // ServerResult is a union over sync/async/task shapes — our handlers
    // are always sync-completion (content + isError). Cast keeps the
    // SDK happy without forcing every tool to declare task metadata.
    return result as unknown as Awaited<ReturnType<typeof tool.handler>> & { _meta?: Record<string, unknown> };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stay alive until stdio closes.
  process.stderr.write(`${SERVER_NAME} MCP server v${SERVER_VERSION} ready (${TOOLS.length} tools)\n`);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
