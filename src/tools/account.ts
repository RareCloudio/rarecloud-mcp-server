// Account tools — profile, SSH keys, limits. Read-only.

import { APIError } from '../client.js';
import { type ToolDefinition, jsonResult, errorResult } from './types.js';

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
      const id = args.service_id as string;
      const data = await client.get(`/v1/services/${encodeURIComponent(id)}/ssh-keys`);
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
