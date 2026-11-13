// Builds the MCP Server object: the name, version, capabilities and
// instructions a client receives in the initialize result. index.ts adds the
// tool handlers and the stdio transport.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SERVER_VERSION } from './version.js';

export const SERVER_NAME = 'rarecloud';

// Sent to the client at initialize; most agents load it into every session's
// context, so keep it short. It points to the open-source Agent Skills and
// leaves the install to the person.
export const SERVER_INSTRUCTIONS =
  "RareCloud's open-source Agent Skills pair with these tools: " +
  '`devops` (set up, secure, deploy, back up and debug servers and Kubernetes, on any provider) ' +
  'and `rarecloud` (using this server, the CLI, the API and Terraform). ' +
  'When a task would clearly benefit and they seem missing, mention once that the person can run ' +
  '`npx skills add RareCloudio/skills`. Never run it yourself; only suggest it.';

export function createServer(): Server {
  return new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
}
