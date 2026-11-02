// Outbound email (SMTP port 25) WRITE tool (API: POST
// /v1/services/:id/smtp/unblock-request in api/src/routes/v1-services.ts).
// Scope services:write.
//
// Safety: `sensitive`, by analogy with request_quota_increase and create_ticket.
// It charges nothing and changes nothing on the VM, but it opens a support ticket
// in the user's name, its answers are statements a human operator reviews to
// decide, and a rejection starts a 7-day wait before the next request. The agent
// must surface the answers to the user first.
//
// No idempotency_key: the API exempts this route from Idempotency-Key (one
// request can be pending per VM, so a repeat answers CONFLICT instead of opening
// a second ticket).
//
// The input mirrors the API's smtpAnswersSchema (api/src/lib/smtp/requests.ts)
// field for field, including the three conditional rules, so a bad answer is
// refused here without a request.

import { z } from 'zod';
import { type ToolDefinition } from './types.js';
import { writeTool, encodeSegment } from './factories.js';

// The API's FQDN_RE: a dotted hostname with a letter-led last label.
const FQDN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const fqdn = z.string().trim().regex(FQDN_RE, 'must be a valid domain name, for example mail.example.com');
const longText = z.string().trim().min(20).max(2000);

const PURPOSES = ['own_domain_mail', 'transactional', 'newsletter', 'other'] as const;
const RECIPIENTS = ['own_users', 'opted_in', 'other'] as const;

const answersSchema = z
  .object({
    service_id: z.string().min(1),
    purpose: z.enum(PURPOSES),
    purposeOther: longText.optional(),
    software: z.string().trim().min(2).max(200),
    domains: z.array(fqdn).min(1).max(10),
    spf: z.boolean(),
    dkim: z.boolean(),
    dmarc: z.boolean(),
    rdns: fqdn.optional(),
    recipients: z.enum(RECIPIENTS),
    recipientsOther: longText.optional(),
    listSource: longText.optional(),
    messagesPerDay: z.number().int().min(1).max(1_000_000),
    acceptPolicy: z.literal(true),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.purpose === 'other' && !a.purposeOther) {
      ctx.addIssue({ code: 'custom', path: ['purposeOther'], message: 'required when purpose is other' });
    }
    if (a.recipients === 'other' && !a.recipientsOther) {
      ctx.addIssue({ code: 'custom', path: ['recipientsOther'], message: 'required when recipients is other' });
    }
    if (a.purpose === 'newsletter' && !a.listSource) {
      ctx.addIssue({ code: 'custom', path: ['listSource'], message: 'required when purpose is newsletter' });
    }
  });

const HOSTNAME_PATTERN = FQDN_RE.source;

export const requestSmtpUnblock: ToolDefinition = writeTool({
  name: 'request_smtp_unblock',
  description:
    `Ask RareCloud to open outbound email on TCP port 25 for a cloud VM. Only port 25 is blocked on new ` +
    `cloud servers: ports 465 and 587 to a mail provider work without any request, so prefer those when ` +
    `they are enough. Requires scope services:write. The request opens a support ticket and a human ` +
    `operator decides; once approved, port 25 opens on the VM. Check the state first and follow it with ` +
    `get_service_smtp. One request can be pending per VM. The answers describe the mail the server sends: ` +
    `purpose, software, domains (1-10) with their SPF, DKIM and DMARC state, optional rdns, recipients, ` +
    `messagesPerDay, and acceptPolicy (must be true: the user accepts the acceptable use policy for ` +
    `outbound email). purposeOther is required when purpose is other, recipientsOther when recipients is ` +
    `other, and listSource when purpose is newsletter (each 20-2000 chars). After a rejection or a revoked ` +
    `approval a new request waits 7 days: the API answers 409 CONFLICT naming the date (canRequestAfter, ` +
    `also shown by get_service_smtp).`,
  method: 'POST',
  safety: {
    kind: 'sensitive',
    reason:
      "submits an outbound email request on the user's behalf; it opens a support ticket that a RareCloud operator reviews, and a rejection blocks a new request for 7 days",
  },
  input: answersSchema,
  inputSchema: {
    type: 'object',
    properties: {
      service_id: { type: 'string', minLength: 1, description: 'Cloud VM service_id from list_services.' },
      purpose: { type: 'string', enum: [...PURPOSES], description: 'What the server sends.' },
      purposeOther: {
        type: 'string', minLength: 20, maxLength: 2000,
        description: 'What the server sends, in words. Required when purpose is other.',
      },
      software: { type: 'string', minLength: 2, maxLength: 200, description: 'The mail software, e.g. Postfix.' },
      domains: {
        type: 'array', minItems: 1, maxItems: 10,
        items: { type: 'string', pattern: HOSTNAME_PATTERN },
        description: 'The domains the server sends from, e.g. ["mail.example.com"] (1-10).',
      },
      spf: { type: 'boolean', description: 'An SPF record covers the server.' },
      dkim: { type: 'boolean', description: 'Outgoing mail is DKIM-signed.' },
      dmarc: { type: 'boolean', description: 'The domains publish a DMARC record.' },
      rdns: {
        type: 'string', pattern: HOSTNAME_PATTERN,
        description: 'Optional: the reverse DNS hostname of the server, if set (see get_service_rdns).',
      },
      recipients: { type: 'string', enum: [...RECIPIENTS], description: 'Who receives the mail.' },
      recipientsOther: {
        type: 'string', minLength: 20, maxLength: 2000,
        description: 'Who receives the mail, in words. Required when recipients is other.',
      },
      listSource: {
        type: 'string', minLength: 20, maxLength: 2000,
        description: 'How the mailing list was built. Required when purpose is newsletter.',
      },
      messagesPerDay: { type: 'integer', minimum: 1, maximum: 1_000_000, description: 'Expected messages per day.' },
      acceptPolicy: {
        type: 'boolean', enum: [true],
        description: 'Must be true: the user accepts the acceptable use policy for outbound email.',
      },
    },
    required: ['service_id', 'purpose', 'software', 'domains', 'spf', 'dkim', 'dmarc', 'recipients', 'messagesPerDay', 'acceptPolicy'],
    additionalProperties: false,
  },
  buildPath: (a) => `/v1/services/${encodeSegment(a.service_id, 'service_id')}/smtp/unblock-request`,
  buildBody: (a) => {
    const { service_id: _serviceId, ...answers } = a;
    return Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined));
  },
});
