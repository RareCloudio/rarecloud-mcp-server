// The server version must be single-sourced from package.json so it can
// never drift from what npm publishes (it previously did: index.ts said
// '0.1.0' while package.json said '0.1.2'). This test reads package.json
// independently (raw file, not via version.ts) and asserts the exported
// SERVER_VERSION matches it exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERVER_VERSION } from './version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

test('SERVER_VERSION is a non-empty string', () => {
  assert.equal(typeof SERVER_VERSION, 'string');
  assert.ok(SERVER_VERSION.length > 0);
});

test('SERVER_VERSION equals package.json version (no drift)', () => {
  assert.equal(SERVER_VERSION, pkg.version);
});
