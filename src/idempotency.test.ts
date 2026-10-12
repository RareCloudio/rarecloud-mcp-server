import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIdempotentPostPath, isValidIdempotencyKey, IDEMPOTENT_POST_ROUTES } from './idempotency.js';

test('idempotency: the mirrored covered-route list has the API branch count (47)', () => {
  assert.equal(IDEMPOTENT_POST_ROUTES.length, 47);
  assert.equal(new Set(IDEMPOTENT_POST_ROUTES).size, 47);
});

test('idempotency: covered POST paths match, with real ids in the :param segments', () => {
  for (const p of [
    '/v1/services',
    '/v1/services/abc-123/actions/reinstall',
    '/v1/services/42/renew',
    '/v1/domains/transfers',
    '/v1/domains/7/renew',
    '/v1/proxies/p1/auth/whitelisted-ips',
    '/v1/object-storage/keys',
    '/v1/services/',
  ]) {
    assert.equal(isIdempotentPostPath(p), true, p);
  }
});

test('idempotency: exempt or unknown POST paths do not match', () => {
  for (const p of [
    '/v1/services/abc/hostname',
    '/v1/services/abc/password',
    '/v1/firewalls/f1/attach',
    '/v1/proxies/p1/auto-renew',
    '/v1/account/affiliate/link',
    '/v1/tickets/1/close',
    '/v1/domains/1/manage',
    '/v1/services/abc/actions/reinstall/extra',
    '/v1/servicesX',
  ]) {
    assert.equal(isIdempotentPostPath(p), false, p);
  }
});

test('idempotency: key validation is 1 to 255 printable ASCII', () => {
  assert.equal(isValidIdempotencyKey('a'), true);
  assert.equal(isValidIdempotencyKey('x'.repeat(255)), true);
  assert.equal(isValidIdempotencyKey('deploy web-1 #2 ~ok'), true);
  assert.equal(isValidIdempotencyKey(''), false);
  assert.equal(isValidIdempotencyKey('x'.repeat(256)), false);
  assert.equal(isValidIdempotencyKey('tab\there'), false);
  assert.equal(isValidIdempotencyKey('café'), false);
  assert.equal(isValidIdempotencyKey(42), false);
});
