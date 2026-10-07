// Per-resource API access (API design 2026-10-07-resource-api-access-design.md).
//
// The user can make a service or domain read-only for agents and API tokens in
// the console. Only the read side has a tool: an agent checks what it may not
// change before planning. The switch endpoints (PUT /v1/services/{id}/api-access,
// PUT /v1/domains/{id}/api-access) deliberately have NO tool: only a console
// session can change API access (index.test.ts pins that exclusion).

import { readList } from './factories.js';

export const listApiAccess = readList(
  'list_api_access',
  '/v1/api-access',
  'Resources the user made read-only for agents and API tokens. Check before planning changes; these cannot ' +
    'be changed by any tool. Returns [{kind: "service" | "domain", id, changedAt}] (an empty list means every ' +
    'resource allows changes). A read-only resource can still be listed and read, but every change to it, and ' +
    'every read of its credentials, is refused with RESOURCE_PROTECTED; only the user can turn API access back ' +
    'on, in the console. Service and domain objects carry the same state as apiAccess: "full" | "read_only".',
);
