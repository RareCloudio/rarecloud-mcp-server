// Registry invariants. These pin the shape of the exposed tool surface so a
// later parity task can't silently break naming, drop a schema, or register a
// duplicate. The count is bumped intentionally by each task that adds tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, findTool } from './index.js';

// Bump this in the same commit that adds/removes tools. A mismatch means the
// registry changed without the test acknowledging it.
const EXPECTED_TOOL_COUNT = 68;

test('registry: tool count matches the expected total', () => {
  assert.equal(TOOLS.length, EXPECTED_TOOL_COUNT);
});

test('registry: every tool name is unique', () => {
  const names = TOOLS.map((t) => t.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, `duplicate tool name(s): ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`);
});

test('registry: every tool has a non-empty name and description', () => {
  for (const t of TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.ok(t.name.length > 0, 'empty tool name');
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.trim().length > 0, `empty description for ${t.name}`);
  }
});

test('registry: every tool has a well-formed object inputSchema', () => {
  for (const t of TOOLS) {
    assert.ok(t.inputSchema, `missing inputSchema for ${t.name}`);
    assert.equal(t.inputSchema.type, 'object', `inputSchema.type must be "object" for ${t.name}`);
    assert.equal(typeof t.inputSchema.properties, 'object', `inputSchema.properties must be an object for ${t.name}`);
  }
});

test('registry: findTool resolves a known tool and misses an unknown one', () => {
  assert.equal(findTool('list_services')?.name, 'list_services');
  assert.equal(findTool('definitely_not_a_tool'), undefined);
});
