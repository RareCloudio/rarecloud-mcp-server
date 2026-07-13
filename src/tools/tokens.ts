// API token tools — read-only. Token creation / revocation stays manual: the
// tokens endpoint is cookie-authenticated (a personal access token cannot list
// or mint other tokens), and secrets are never returned.

import { readList } from './factories.js';

export const listTokens = readList(
  'list_tokens',
  '/v1/tokens',
  'List the personal API tokens on the account: id, name, scopes, created / last-used. Cookie-authenticated only — a bearer token cannot list tokens, and secrets are never returned. Use for "what API tokens exist?" or a credential audit.',
);
