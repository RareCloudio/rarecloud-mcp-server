// The initialize result is how this server introduces itself to a connected
// agent. These tests start the server over an in-memory transport, run the
// real MCP handshake with an SDK client, and check what the agent receives:
// the name and version, and instructions that point to RareCloud's
// open-source Agent Skills without telling the agent to install them alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, SERVER_INSTRUCTIONS, SERVER_NAME } from './server.js';
import { SERVER_VERSION } from './version.js';

// Instructions are loaded into every session's context, so the hint stays small.
const MAX_INSTRUCTIONS_CHARS = 600;

async function initialize(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('initialize: reports the server name and package version', async () => {
  const client = await initialize();
  try {
    assert.deepEqual(client.getServerVersion(), { name: SERVER_NAME, version: SERVER_VERSION });
  } finally {
    await client.close();
  }
});

test('initialize: instructions name the install command and both skills', async () => {
  const client = await initialize();
  try {
    const instructions = client.getInstructions();
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.ok(instructions?.includes('npx skills add RareCloudio/skills'), 'install command missing');
    assert.match(instructions ?? '', /`devops`/);
    assert.match(instructions ?? '', /`rarecloud`/);
  } finally {
    await client.close();
  }
});

test('initialize: instructions tell the agent to ask before installing', async () => {
  const client = await initialize();
  try {
    assert.match(client.getInstructions() ?? '', /do not run it yourself without asking/i);
  } finally {
    await client.close();
  }
});

test('instructions: short enough to load into every session', () => {
  assert.ok(
    SERVER_INSTRUCTIONS.length <= MAX_INSTRUCTIONS_CHARS,
    `instructions are ${SERVER_INSTRUCTIONS.length} chars, limit ${MAX_INSTRUCTIONS_CHARS}`,
  );
});

test('instructions: no em dashes', () => {
  assert.ok(!SERVER_INSTRUCTIONS.includes('—'));
});
