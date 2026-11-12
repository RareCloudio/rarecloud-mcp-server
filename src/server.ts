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
  'RareCloud publishes open-source Agent Skills that pair with these tools: ' +
  '`devops` (set up and secure servers, deploy to a server or Kubernetes, backups, debugging) ' +
  'and `rarecloud` (how to use this server, the CLI, the API and Terraform). ' +
  'If they are not installed, suggest the person run `npx skills add RareCloudio/skills`; ' +
  'do not run it yourself without asking.';

export function createServer(): Server {
  return new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
}
