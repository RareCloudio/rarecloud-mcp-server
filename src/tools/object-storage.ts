// Object Storage READ tools: the S3-compatible storage service account, its
// regions, usage series, buckets and access keys (metadata only: a key's secret
// is shown once, by create_object_storage_key, and never again). Every route is
// services:read; shapes mirror api/src/routes/v1-object-storage.ts.

import { readList, readOne, readTool, encodeSegment } from './factories.js';

// `?days=` on both usage series: the API clamps to 1-90 and defaults to 30.
const DAYS_PROPERTY = {
  type: 'integer',
  minimum: 1,
  maximum: 90,
  description: 'How many days of daily history to return (1-90, default 30).',
} as const;

function withDays(path: string, days: unknown): string {
  return days === undefined ? path : `${path}?${new URLSearchParams({ days: String(days) }).toString()}`;
}

export const getObjectStorage = readList(
  'get_object_storage',
  '/v1/object-storage',
  'Get the account\'s Object Storage (S3-compatible) service: status, namespace handle (the prefix every bucket name carries), plan, the price card (base monthly fee, included GB, per-GB storage and egress, CDN fees), this month\'s accrued charge, and the bucket and key limits. Returns null when Object Storage is not enabled. Use for "do I have object storage?" or "what does it cost me this month?".',
);

export const listObjectStorageRegions = readList(
  'list_object_storage_regions',
  '/v1/object-storage/regions',
  'List the regions a bucket can be created in: id, label, S3 endpoint, country, and whether it is in the EU. Works before Object Storage is enabled. Use to pick the region for create_bucket.',
);

export const getObjectStorageUsage = readTool({
  name: 'get_object_storage_usage',
  description:
    'Get the Object Storage account\'s daily usage series (active and deleted stored bytes, egress bytes, CDN bytes and requests) for the last N days. Fails when Object Storage is not enabled. Use for "how much am I storing / transferring?".',
  inputSchema: {
    type: 'object',
    properties: { days: DAYS_PROPERTY },
    additionalProperties: false,
  },
  buildPath: (args) => withDays('/v1/object-storage/usage', args.days),
});

export const listBuckets = readList(
  'list_buckets',
  '/v1/object-storage/buckets',
  'List Object Storage buckets: id, full bucket name, region, status, versioning, whether it is public over the CDN, its S3 endpoint and URLs, and the last measured size and object count. Empty when Object Storage is not enabled. Use to find a bucket id or bucket name.',
);

export const getBucket = readOne(
  'get_bucket',
  '/v1/object-storage/buckets',
  'Get one Object Storage bucket: full bucket name, region, status, versioning, public (CDN) state and public URL, S3 endpoint and bucket URL, and the last measured size and object count. Use after list_buckets to inspect a single bucket.',
  'id',
  { idSource: 'list_buckets' },
);

export const getBucketUsage = readTool({
  name: 'get_bucket_usage',
  description:
    'Get one bucket\'s daily usage series (active and deleted stored bytes, egress bytes, and CDN bytes and requests if it has ever been public) for the last N days. The id comes from list_buckets.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Bucket id from list_buckets.' },
      days: DAYS_PROPERTY,
    },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (args) => withDays(`/v1/object-storage/buckets/${encodeSegment(args.id, 'id')}/usage`, args.days),
});

export const listObjectStorageKeys = readList(
  'list_object_storage_keys',
  '/v1/object-storage/keys',
  'List Object Storage S3 access keys: id, name, access key id, a four-character secret preview, scope (buckets + read or readwrite), status and revocation time. Never returns a secret. Use to find a key id or to audit which keys exist.',
);
