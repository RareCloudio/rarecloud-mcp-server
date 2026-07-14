// Account-safe WRITE tools (Parity Phase B, Task 8). SECURITY POLICY: an agent
// PAT manages infrastructure — never identity, credentials, or raw money. These
// six are the ONLY account-adjacent writes that policy allows; every one is
// scope account:write and NONE touches a password, 2FA, sub-user invite, or
// affiliate activate/withdraw. The excluded operations have NO tool at all — the
// registry-level exclusion guard in index.test.ts proves it.
//
// Everything builds on the shared `writeTool` factory so input validation, the
// confirm gate, `encodeSegment` path encoding, and the APIError -> errorResult
// mapping stay uniform with the other *-write.ts modules.
//
// Only delete_account_ssh_key is gated (confirm + destructiveHint — it removes
// an access credential from the account). The rest are plain writes.
//
// Bodies + bounds re-confirmed against console openapi.json AND the route
// source (api/src/routes/v1-account.ts). DEVIATIONS / enrichments over the
// brief's bare cells:
//   - update_account: the brief's field list includes `preferredCurrency`, but
//     the route's AccountPatchInput allow-list does NOT accept it (unknown keys
//     are stripped server-side). openapi's PATCH body merely $refs the full
//     `Account` RESPONSE schema (which carries preferredCurrency as a read
//     field) — reality (route) wins, so preferredCurrency is DROPPED and is
//     rejected by the strict schema. All other fields are optional. Per-field
//     maxLengths, country length(2), email format, and the language enum come
//     straight from the route (openapi confirms the same bounds). We do NOT
//     re-implement the route's server-side SAFE_NAME_RE / phone / STRICT_EMAIL
//     refinements client-side (those are server defenses we can't import; the
//     server re-validates) — matching the infra-write "mirror bounds" precedent.
//   - add_account_ssh_key: openapi/route bound name to 1-200 and publicKey to
//     1-4096 (brief's cells were bare strings); mirrored in both layers.
//   - manage_account_contact: modeled as the brief's FLAT schema (the server
//     enforces the per-action discriminated requirements — add needs
//     firstname/lastname/email, update/delete need id); id is a positive int;
//     firstname/lastname max 64, email max 254 + format, phonenumber max 32,
//     companyname max 128 (route + openapi). The three email-preference flags
//     are modeled as booleans (the route also accepts number/string, but
//     boolean is the sensible agent-facing subset + matches openapi).
//   - create_affiliate_link: destination bound to 1-2048 (route
//     affiliateLinkSchema; openapi omits the maxLength) — mirrored both layers.
//     The route additionally requires an absolute http(s) URL (validated by the
//     signed-link builder server-side); the description notes it.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

const LANGUAGES = ['en', 'ro'] as const;
const CONTACT_ACTIONS = ['add', 'update', 'delete'] as const;

// --- update_account (PATCH /v1/account, no gate) ---------------------------

export const updateAccount: ToolDefinition = writeTool({
  name: 'update_account',
  description:
    "Update the account's billing / contact profile. Requires scope account:write. Plain write — not " +
    'gated. Every field is optional; only the fields you pass are changed. firstName/lastName (max 64), ' +
    'companyName (max 128), address (max 128), city (max 64), postcode (max 16), country (2-letter ISO ' +
    'code), phone (max 32), taxId/VAT (max 32), language (en|ro), and email (the billing/contact email — ' +
    'the login email is NOT changed here). Note: the account currency is NOT settable via this endpoint.',
  method: 'PATCH',
  input: z
    .object({
      firstName: z.string().max(64).optional(),
      lastName: z.string().max(64).optional(),
      companyName: z.string().max(128).optional(),
      address: z.string().max(128).optional(),
      city: z.string().max(64).optional(),
      postcode: z.string().max(16).optional(),
      country: z.string().length(2, 'Country must be a 2-letter ISO code.').optional(),
      phone: z.string().max(32).optional(),
      taxId: z.string().max(32).optional(),
      language: z.enum(LANGUAGES).optional(),
      email: z.string().email('Enter a valid email address.').max(254).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      firstName: { type: 'string', maxLength: 64, description: 'Given name.' },
      lastName: { type: 'string', maxLength: 64, description: 'Family name.' },
      companyName: { type: 'string', maxLength: 128, description: 'Company / organisation name.' },
      address: { type: 'string', maxLength: 128, description: 'Street address.' },
      city: { type: 'string', maxLength: 64, description: 'City.' },
      postcode: { type: 'string', maxLength: 16, description: 'Postal / ZIP code.' },
      country: { type: 'string', minLength: 2, maxLength: 2, description: '2-letter ISO country code.' },
      phone: { type: 'string', maxLength: 32, description: 'Phone number.' },
      taxId: { type: 'string', maxLength: 32, description: 'Tax / VAT identification number.' },
      language: { type: 'string', enum: [...LANGUAGES], description: 'Preferred language.' },
      email: { type: 'string', format: 'email', maxLength: 254, description: 'Billing / contact email (not the login email).' },
    },
    required: [],
    additionalProperties: false,
  },
  buildPath: () => '/v1/account',
  buildBody: (a) => {
    const body: Record<string, unknown> = {};
    if (a.firstName !== undefined) body.firstName = a.firstName;
    if (a.lastName !== undefined) body.lastName = a.lastName;
    if (a.companyName !== undefined) body.companyName = a.companyName;
    if (a.address !== undefined) body.address = a.address;
    if (a.city !== undefined) body.city = a.city;
    if (a.postcode !== undefined) body.postcode = a.postcode;
    if (a.country !== undefined) body.country = a.country;
    if (a.phone !== undefined) body.phone = a.phone;
    if (a.taxId !== undefined) body.taxId = a.taxId;
    if (a.language !== undefined) body.language = a.language;
    if (a.email !== undefined) body.email = a.email;
    return body;
  },
});

// --- add_account_ssh_key (POST /v1/account/ssh-keys, no gate) --------------

export const addAccountSshKey: ToolDefinition = writeTool({
  name: 'add_account_ssh_key',
  description:
    'Add an account-wide SSH public key (usable when deploying new cloud VMs). Requires scope ' +
    'account:write. Plain write — not gated. name is a display label (1-200, unique per account); ' +
    'publicKey is the OpenSSH public-key string (ssh-ed25519 / ssh-rsa / ecdsa, max 4096). This is a ' +
    'PUBLIC key — never paste a private key. Distinct from the per-service add_service_ssh_key.',
  method: 'POST',
  input: z
    .object({
      name: z.string().min(1).max(200),
      publicKey: z.string().min(1).max(4096),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200, description: 'Display name (unique per account).' },
      publicKey: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description: 'OpenSSH PUBLIC key string (ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp*).',
      },
    },
    required: ['name', 'publicKey'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/account/ssh-keys',
  buildBody: (a) => ({ name: a.name, publicKey: a.publicKey }),
});

// --- delete_account_ssh_key (DELETE /v1/account/ssh-keys/{id}, confirm+destr) --

export const deleteAccountSshKey: ToolDefinition = writeTool({
  name: 'delete_account_ssh_key',
  description:
    'Delete an account-wide SSH key. Requires scope account:write. IRREVERSIBLE: removes an access ' +
    'credential from the account (the key must be re-added to use it again). Pass confirm:true only after ' +
    'the user has explicitly approved. id comes from list_account_ssh_keys.',
  method: 'DELETE',
  input: z.object({ id: z.string().min(1) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, description: 'SSH key id from list_account_ssh_keys.' } },
    required: ['id'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/account/ssh-keys/${encodeSegment(a.id, 'id')}`,
  confirm: true,
  destructiveHint: true,
});

// --- resend_email_verification (POST /v1/account/verify-email/resend) ------

export const resendEmailVerification: ToolDefinition = writeTool({
  name: 'resend_email_verification',
  description:
    "Resend the account's email-address verification email. Requires scope account:write. Plain write — " +
    'not gated. Takes no input (the target is the authenticated account); a no-op if the email is already ' +
    'verified. Returns { sent, reason? }.',
  method: 'POST',
  input: z.object({}).strict(),
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  buildPath: () => '/v1/account/verify-email/resend',
});

// --- manage_account_contact (POST /v1/account/contacts, no gate) -----------

export const manageAccountContact: ToolDefinition = writeTool({
  name: 'manage_account_contact',
  description:
    'Add, update, or delete a billing/technical contact on the account. Requires scope account:write. ' +
    'Plain write — not gated. action selects the operation: add (needs firstname, lastname, email), ' +
    'update (needs id + the fields to change), delete (needs id). id comes from list_account_contacts. ' +
    'generalemails / invoiceemails / supportemails toggle which notification streams this contact ' +
    'receives.',
  method: 'POST',
  input: z
    .object({
      action: z.enum(CONTACT_ACTIONS),
      id: z.number().int().positive().optional(),
      firstname: z.string().max(64).optional(),
      lastname: z.string().max(64).optional(),
      email: z.string().email('Enter a valid email address.').max(254).optional(),
      phonenumber: z.string().max(32).optional(),
      companyname: z.string().max(128).optional(),
      generalemails: z.boolean().optional(),
      invoiceemails: z.boolean().optional(),
      supportemails: z.boolean().optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...CONTACT_ACTIONS], description: 'add | update | delete.' },
      id: { type: 'integer', minimum: 1, description: 'Contact id (required for update/delete).' },
      firstname: { type: 'string', maxLength: 64, description: 'Given name (required for add).' },
      lastname: { type: 'string', maxLength: 64, description: 'Family name (required for add).' },
      email: { type: 'string', format: 'email', maxLength: 254, description: 'Contact email (required for add).' },
      phonenumber: { type: 'string', maxLength: 32, description: 'Phone number.' },
      companyname: { type: 'string', maxLength: 128, description: 'Company name.' },
      generalemails: { type: 'boolean', description: 'Receive general emails.' },
      invoiceemails: { type: 'boolean', description: 'Receive invoice emails.' },
      supportemails: { type: 'boolean', description: 'Receive support emails.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/account/contacts',
  buildBody: (a) => {
    const body: Record<string, unknown> = { action: a.action };
    if (a.id !== undefined) body.id = a.id;
    if (a.firstname !== undefined) body.firstname = a.firstname;
    if (a.lastname !== undefined) body.lastname = a.lastname;
    if (a.email !== undefined) body.email = a.email;
    if (a.phonenumber !== undefined) body.phonenumber = a.phonenumber;
    if (a.companyname !== undefined) body.companyname = a.companyname;
    if (a.generalemails !== undefined) body.generalemails = a.generalemails;
    if (a.invoiceemails !== undefined) body.invoiceemails = a.invoiceemails;
    if (a.supportemails !== undefined) body.supportemails = a.supportemails;
    return body;
  },
});

// --- create_affiliate_link (POST /v1/account/affiliate/link, no gate) ------

export const createAffiliateLink: ToolDefinition = writeTool({
  name: 'create_affiliate_link',
  description:
    'Mint a signed affiliate referral link that redirects to a destination of your choice after placing ' +
    'the affiliate cookie. Requires scope account:write. Plain write — NO money movement (affiliate ' +
    'activate and withdraw are intentionally NOT exposed to agents). The affiliate account must already ' +
    'be active. destination is the absolute http(s) URL to redirect to (1-2048 chars).',
  method: 'POST',
  input: z.object({ destination: z.string().min(1).max(2048) }).strict(),
  inputSchema: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        minLength: 1,
        maxLength: 2048,
        description: 'Absolute http(s) URL to redirect to after the affiliate cookie is placed.',
      },
    },
    required: ['destination'],
    additionalProperties: false,
  },
  buildPath: () => '/v1/account/affiliate/link',
  buildBody: (a) => ({ destination: a.destination }),
});
