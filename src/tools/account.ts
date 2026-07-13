// Account tools — profile, SSH keys, limits, linked users, affiliate, 2FA,
// activity trail, emails, contacts. Read-only.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';
import { readList, readTool, encodeSegment } from './factories.js';

export const getAccount: ToolDefinition = {
  name: 'get_account',
  description: 'Get the authenticated user\'s profile: email, name, country, billing currency, account creation date. Use for "what account am I on?" or to confirm identity before suggesting cross-account actions.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(client) {
    try {
      const data = await client.get('/v1/account');
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const listSshKeys: ToolDefinition = {
  name: 'list_ssh_keys',
  description: 'List the SSH keys on a specific server (legacy VPS). SSH keys are per-server in the API, not account-wide. Pass a service_id from list_services.',
  inputSchema: {
    type: 'object',
    properties: {
      service_id: {
        type: 'string',
        description: 'Server ID from list_services.',
      },
    },
    required: ['service_id'],
    additionalProperties: false,
  },
  async handler(client, args) {
    try {
      // There is no account-wide ssh-keys endpoint; keys are per-service.
      const id = encodeSegment(args.service_id, 'service_id');
      const data = await client.get(`/v1/services/${id}/ssh-keys`);
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const getAccountLimits: ToolDefinition = {
  name: 'get_account_limits',
  description: 'Get account resource limits and current usage (servers / vCPUs / snapshots / IPs / volumes / DNS zones / etc). Use before recommending a deploy to make sure the user has headroom.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(client) {
    try {
      const data = await client.get('/v1/account/limits');
      return jsonResult(data);
    } catch (e) {
      return errorResult(e instanceof APIError ? e.message : (e as Error).message);
    }
  },
};

export const listAccountClients = readList(
  'list_account_clients',
  '/v1/account/clients',
  'List the users linked to this client account — accepted members AND pending invitations. Each entry has a status (active / invited / disabled); the account owner is flagged isOwner. Use for "who has access to my account?" or to find a linked user before discussing collaborators.',
);

export const getAffiliate = readList(
  'get_affiliate',
  '/v1/account/affiliate',
  'Get the authenticated account\'s affiliate status and stats: referral link, visitors / signups / conversion rate, commissions summary (pending maturation / available balance / total withdrawn), payout minimum, and the per-referral list. Returns {active:false} when the affiliate program is not enabled. Use for "how are my referrals doing?".',
);

export const getTwoFactorStatus = readList(
  'get_two_factor_status',
  '/v1/account/two-factor',
  'Get the authenticated user\'s two-factor (TOTP) status — whether 2FA is enabled on the account. Use to check the account\'s security posture before advising on hardening.',
);

export const listAccountSshKeys = readList(
  'list_account_ssh_keys',
  '/v1/account/ssh-keys',
  'List the account-wide SSH public keys registered on the profile — the keys offered at deploy time when creating a new server. Account-scoped, NOT per-server: for the keys already installed on one running server use list_ssh_keys (service_id) instead.',
);

export const getAccountActivity = readTool({
  name: 'get_account_activity',
  description: 'Get the account audit trail (newest first): sign-ins, 2FA changes, service actions, and billing operations. Page with limit (1–200, default 50) and before (a cursor from a prior page). Use for "show my recent account activity" or a security review.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max entries to return (1–200, default 50).' },
      before: { type: 'string', description: 'Pagination cursor — return entries older than this (from a previous page).' },
    },
    additionalProperties: false,
  },
  buildPath: (args) => {
    const q = new URLSearchParams();
    if (args.limit !== undefined) q.set('limit', String(args.limit));
    if (args.before !== undefined && args.before !== '') q.set('before', String(args.before));
    const s = q.toString();
    return s ? `/v1/account/activity?${s}` : '/v1/account/activity';
  },
});

export const listAccountEmails = readTool({
  name: 'list_account_emails',
  description: 'List the emails WHMCS sent to this account (invoices, notices, password resets), newest first. Pass id to fetch a single message including its HTML body; page older results with offset. Use for "what emails did I get?" or to read one message.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Fetch one email by id (returns its HTML body). Omit to list.' },
      offset: { type: 'integer', minimum: 0, description: 'Pagination offset into the list (default 0).' },
    },
    additionalProperties: false,
  },
  buildPath: (args) => {
    const q = new URLSearchParams();
    if (args.offset !== undefined) q.set('offset', String(args.offset));
    if (args.id !== undefined && args.id !== '') q.set('id', String(args.id));
    const s = q.toString();
    return s ? `/v1/account/emails?${s}` : '/v1/account/emails';
  },
});

export const listAccountContacts = readList(
  'list_account_contacts',
  '/v1/account/contacts',
  'List the account\'s billing / technical contacts — additional email-copy recipients with no login of their own. Use for "who else receives my invoices and notices?".',
);
