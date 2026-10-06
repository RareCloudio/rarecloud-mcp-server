// Object Storage WRITE tools: enable / disable the service, create / update /
// delete buckets, and create / revoke S3 access keys. All scope services:write;
// methods, paths and bodies mirror api/src/routes/v1-object-storage.ts and its
// services (objectStorageAccounts.ts, objectStorageBuckets.ts,
// objectStorageKeys.ts).
//
// Classification, from what the API actually does:
//   - enable_object_storage, create_bucket: spends. Enabling starts the
//     pay-as-you-go base fee (accrued hourly from creation, even with no
//     bucket). Creating a bucket enables the service when it is off, or wakes a
//     paused one, so the first bucket starts the same fee.
//   - update_bucket: sensitive. public:true serves every object in the bucket to
//     anyone through its CDN hostname (and adds the per-bucket CDN fee).
//   - disable_object_storage: destructive. It permanently deletes the storage
//     account and frees its namespace handle; the API refuses while any bucket
//     or active key remains.
//   - delete_bucket: destructive; purge:true first deletes every object.
//   - create_object_storage_key: sensitive + returnsSecret (the secret is shown
//     once and never stored).
//   - delete_object_storage_key: destructive. Revoking deletes the key's IAM
//     user upstream; the same key can never come back (a new key has a new id
//     and secret), matching revoke_cluster_kubeconfig.
//
// The API's own `confirm` query parameter on bucket delete (the typed bucket
// name) is exposed as `bucket_name`, because `confirm` is the factory-owned
// approval flag on every gated tool.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

// --- account ------------------------------------------------------------------

export const enableObjectStorage: ToolDefinition = writeTool({
  name: 'enable_object_storage',
  description:
    'Enable Object Storage (S3-compatible) on the account. Requires scope services:write. Takes no input ' +
    'and is idempotent: if it is already enabled the existing service is returned. Not needed before ' +
    'create_bucket, which enables the service itself; the namespace handle is chosen at the first ' +
    'create_bucket. get_object_storage shows the price card.',
  method: 'POST',
  safety: {
    kind: 'spends',
    reason:
      'starts the Object Storage monthly base fee, accrued hourly from now even before any bucket exists, ' +
      'plus per-GB charges for storage above the included allowance and for egress',
  },
  input: z.object({}).strict(),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  buildPath: () => '/v1/object-storage',
});

export const disableObjectStorage: ToolDefinition = writeTool({
  name: 'disable_object_storage',
  description:
    'Disable Object Storage and remove the storage account. Requires scope services:write. Takes no input. ' +
    'The API refuses while any bucket exists or any access key is active: delete every bucket ' +
    '(delete_bucket) and revoke every key (delete_object_storage_key) first. Deleting the last bucket ' +
    'already pauses the base fee, so this is only needed to close the service for good.',
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason:
      'permanently deletes the Object Storage account and releases its namespace handle (the prefix on ' +
      'every bucket name) so anyone can claim it',
  },
  input: z.object({}).strict(),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  buildPath: () => '/v1/object-storage',
});

// --- buckets ------------------------------------------------------------------

export const createBucket: ToolDefinition = writeTool({
  name: 'create_bucket',
  description:
    'Create an Object Storage bucket. Requires scope services:write. name is your part of the bucket ' +
    'name (3-40 chars, no dots); the full bucket name is <handle>-<name>. region comes from ' +
    'list_object_storage_regions. handle is the account\'s namespace (3-16 chars): required on the first ' +
    'bucket of an account that has none yet (get_object_storage shows it), and afterwards omitted or equal ' +
    'to the stored one; it can never be changed. versioning keeps old object versions, which are billed ' +
    'as stored data. Enables Object Storage if it is off.',
  method: 'POST',
  safety: {
    kind: 'spends',
    reason:
      'enables Object Storage (or wakes a paused one) if this is the first bucket, which starts the monthly ' +
      'base fee, and everything stored in the bucket is billed per GB above the included allowance',
  },
  input: z
    .object({
      name: z.string().min(3).max(40),
      region: z.string().min(1),
      versioning: z.boolean().optional(),
      handle: z.string().min(3).max(16).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 40, description: 'Your part of the bucket name (3-40 chars, no dots).' },
      region: { type: 'string', minLength: 1, description: 'Region id from list_object_storage_regions.' },
      versioning: { type: 'boolean', description: 'Keep old object versions (billed as stored data). Default false.' },
      handle: {
        type: 'string',
        minLength: 3,
        maxLength: 16,
        description: 'Account namespace prefix (3-16 chars). Required on the first bucket of an account without one; otherwise omit it.',
      },
    },
    required: ['name', 'region'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/object-storage/buckets',
  buildBody: (a) => {
    const body: Record<string, unknown> = { name: a.name, region: a.region };
    if (a.versioning !== undefined) body.versioning = a.versioning;
    if (a.handle !== undefined) body.handle = a.handle;
    return body;
  },
});

export const updateBucket: ToolDefinition = writeTool({
  name: 'update_bucket',
  description:
    'Change a bucket\'s versioning or public delivery. Requires scope services:write. id comes from ' +
    'list_buckets. Pass at least one of versioning and public; only the fields given change. public:true ' +
    'serves the bucket over the CDN at its public URL (direct S3 access stays private); public:false takes ' +
    'that URL offline.',
  method: 'PATCH',
  safety: {
    kind: 'sensitive',
    reason:
      'can make every object in the bucket readable by anyone on the internet at its public URL (and adds ' +
      'the per-bucket CDN monthly fee plus CDN traffic charges), or take a public bucket offline for ' +
      'everyone using it',
  },
  input: z
    .object({
      id: z.string().min(1),
      versioning: z.boolean().optional(),
      public: z.boolean().optional(),
    })
    .strict()
    .refine((a) => a.versioning !== undefined || a.public !== undefined, {
      message: 'pass at least one of versioning or public',
    }),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Bucket id from list_buckets.' },
      versioning: { type: 'boolean', description: 'Keep old object versions (billed as stored data).' },
      public: { type: 'boolean', description: 'true: serve the bucket publicly over the CDN. false: make it private again.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/object-storage/buckets/${encodeSegment(a.id, 'id')}`,
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.versioning !== undefined) body.versioning = a.versioning;
    if (a.public !== undefined) body.public = a.public;
    return body;
  },
});

export const deleteBucket: ToolDefinition = writeTool({
  name: 'delete_bucket',
  description:
    'Delete an Object Storage bucket. Requires scope services:write. id comes from list_buckets; ' +
    'bucket_name must be that bucket\'s full name exactly as list_buckets shows it. A bucket that still ' +
    'holds objects is refused unless purge is true. Deleting the last bucket pauses the Object Storage base ' +
    'fee; the account itself is kept.',
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason:
      'permanently deletes the bucket, and with purge:true every object and object version in it first; ' +
      'none of it can be recovered',
  },
  input: z
    .object({
      id: z.string().min(1),
      bucket_name: z.string().min(1),
      purge: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, description: 'Bucket id from list_buckets.' },
      bucket_name: {
        type: 'string',
        minLength: 1,
        description: 'The bucket\'s full name (the name field from list_buckets or get_bucket), typed back as the API\'s delete confirmation.',
      },
      purge: { type: 'boolean', description: 'true: delete every object in the bucket first. Default false (a non-empty bucket is refused).' },
    },
    required: ['id', 'bucket_name'],
    additionalProperties: false,
  },
  buildPath: (a) => {
    const q = new URLSearchParams({ confirm: a.bucket_name });
    if (a.purge === true) q.set('purge', 'true');
    return `/v1/object-storage/buckets/${encodeSegment(a.id, 'id')}?${q.toString()}`;
  },
});

// --- access keys --------------------------------------------------------------

export const createObjectStorageKey: ToolDefinition = writeTool({
  name: 'create_object_storage_key',
  description:
    'Create an S3 access key for Object Storage. Requires scope services:write. name is your label ' +
    '(1-80 chars); buckets is "*" for every bucket in the account or a list of bucket ids from ' +
    'list_buckets; access is read or readwrite. Keys cannot be edited: to change the scope, create a new ' +
    'key and revoke the old one. The result holds accessKeyId and secretAccessKey; the secret is shown ' +
    'only this once.',
  method: 'POST',
  safety: {
    kind: 'sensitive',
    reason: 'creates a new credential that can read (or read and write) the chosen buckets until it is revoked',
  },
  returnsSecret: 'the new key\'s secretAccessKey (shown only this once, never retrievable again)',
  input: z
    .object({
      name: z.string().min(1).max(80),
      buckets: z.union([z.literal('*'), z.array(z.string().uuid()).min(1)]),
      access: z.enum(['read', 'readwrite']),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80, description: 'Your label for the key (1-80 chars).' },
      buckets: {
        description: '"*" for every bucket in the account, or a list of bucket ids from list_buckets.',
        oneOf: [
          { type: 'string', enum: ['*'] },
          { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
        ],
      },
      access: { type: 'string', enum: ['read', 'readwrite'], description: 'read, or readwrite.' },
    },
    required: ['name', 'buckets', 'access'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/object-storage/keys',
  buildBody: (a) => ({ name: a.name, scope: { buckets: a.buckets, access: a.access } }),
});

export const deleteObjectStorageKey: ToolDefinition = writeTool({
  name: 'delete_object_storage_key',
  description:
    'Revoke an Object Storage S3 access key. Requires scope services:write. id comes from ' +
    'list_object_storage_keys. Revoking an already revoked key is a no-op.',
  method: 'DELETE',
  safety: {
    kind: 'destructive',
    reason:
      'permanently revokes the key; every application using it loses access to the buckets at once, and the ' +
      'key cannot be restored (a replacement has a new id and secret)',
  },
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'Access key id from list_object_storage_keys.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/object-storage/keys/${encodeSegment(a.id, 'id')}`,
});
