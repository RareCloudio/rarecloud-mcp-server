// Idempotency-Key support (API design 2026-10-07-idempotency-keys-design.md).
//
// The API honours an `Idempotency-Key` header on a fixed list of POST routes: it
// runs the operation at most once per key and replays the first answer to a retry
// with the same key. This file mirrors that list (api/src/routes/_idempotency.ts,
// IDEMPOTENT_POST_ROUTES, with the `/api/v1` prefix written as the public `/v1`).
// It is the ONE place this server decides whether a POST may carry the header:
// the client never sends it to any other route, and never retries any other POST.

/** POST route templates (`:param` = one path segment) that honour Idempotency-Key. */
export const IDEMPOTENT_POST_ROUTES = [
  '/v1/services',
  '/v1/services/:id/actions/:action',
  '/v1/services/:id/backups',
  '/v1/services/:id/snapshots',
  '/v1/services/:id/kubeconfigs',
  '/v1/services/:id/pools',
  '/v1/services/:id/scale',
  '/v1/services/:id/high-availability',
  '/v1/services/:id/resize',
  '/v1/services/:id/renew',
  '/v1/services/:id/upgrade',
  '/v1/services/:id/cancel',
  '/v1/services/:id/ssh-keys',
  '/v1/services/:id/ssh-keys/library',
  '/v1/reserved-ips',
  '/v1/firewalls',
  '/v1/firewalls/:id/rules',
  '/v1/networks',
  '/v1/volumes',
  '/v1/load-balancers',
  '/v1/load-balancers/:id/members',
  '/v1/object-storage',
  '/v1/object-storage/buckets',
  '/v1/object-storage/keys',
  '/v1/domains',
  '/v1/domains/transfers',
  '/v1/domains/:id/renew',
  '/v1/proxies',
  '/v1/proxies/:id/renew',
  '/v1/proxies/:id/replacements',
  '/v1/proxies/:id/proxy-requests',
  '/v1/proxies/:id/auth/whitelisted-ips',
  '/v1/billing/credit/top-up',
  '/v1/billing/invoices/:id/pay',
  '/v1/billing/vouchers/redeem',
  '/v1/account/clients',
  '/v1/account/contacts',
  '/v1/account/ssh-keys',
  '/v1/account/affiliate/activate',
  '/v1/account/affiliate/withdraw',
  '/v1/tickets',
  '/v1/tickets/:id/replies',
  '/v1/limits/requests',
  '/v1/sandboxes',
  '/v1/registry',
  '/v1/registry/credentials',
  '/v1/registry/clusters/:serviceId',
] as const;

const COMPILED = IDEMPOTENT_POST_ROUTES.map(
  (template) =>
    new RegExp(
      '^' +
        template
          .split('/')
          .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
          .join('/') +
        '$',
    ),
);

/** True when a POST to `path` (query string and trailing slash ignored) honours Idempotency-Key. */
export function isIdempotentPostPath(path: string): boolean {
  let p = path.split('?')[0];
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return COMPILED.some((re) => re.test(p));
}

/** 1 to 255 printable ASCII characters (space through tilde), the API's own rule. */
export const IDEMPOTENCY_KEY_RE = /^[\x20-\x7e]{1,255}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_RE.test(value);
}

/** What a replayed answer said about itself. */
export interface ReplayInfo {
  /** Secret fields the API left out of the replay (they were shown only in the first answer). */
  secretsOmittedOnReplay: string[];
}

/** Ceiling on a server-sent Retry-After before re-asking about an in-progress key. */
export const IN_PROGRESS_RETRY_AFTER_CAP_SECONDS = 10;
/** How many times an IDEMPOTENCY_IN_PROGRESS answer is waited out before giving up. */
export const IN_PROGRESS_MAX_RETRIES = 3;
/** Transport retries when the server generated the key itself (the agent passed none). */
export const GENERATED_KEY_TRANSPORT_RETRIES = 1;
