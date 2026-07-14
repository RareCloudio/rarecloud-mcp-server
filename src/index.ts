#!/usr/bin/env node
// MCP server for RareCloud — exposes the /api/v1 surface as tools so that
// AI agents (Claude Code, Claude Desktop, Cursor, custom agents) can inspect
// a RareCloud account, reason about it, and operate its infrastructure.
//
// Design notes:
//   - Reads are ungated. Writes are gated in depth, because the model — not
//     a human — is the caller:
//       * Identity, credentials, and raw money movement have NO tool at all
//         (password, 2FA, account profile, credit top-up, invoice payment,
//         payment methods, token mint/revoke, affiliate withdrawal, panel
//         SSO). An agent PAT manages infrastructure, nothing else.
//       * Spend and lifecycle actions take a mandatory `confirm: true` arg;
//         without it the tool refuses locally, issuing zero HTTP.
//       * Destructive actions additionally carry annotations.destructiveHint
//         so the MCP host can prompt its human before dispatch.
//     Scope is the outer gate and the only human decision: the API enforces
//     it server-side per route and answers 403 PERMISSION_DENIED. Note the
//     tool list is NOT scope-filtered — an under-scoped token still sees a
//     tool, it just gets the API's 403 when it calls it.
//   - Authenticates with a personal access token (Dashboard → Account →
//     API tokens). Grant only the scopes the agent needs — matching is exact,
//     so services:write does NOT imply services:read (grant both to an agent
//     that reads and writes), and wildcard patterns like *:read are unsupported.
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
import { SERVER_VERSION } from './version.js';

const SERVER_NAME = 'rarecloud';

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
      ...(t.annotations ? { annotations: t.annotations } : {}),
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
