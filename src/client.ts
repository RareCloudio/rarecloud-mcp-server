// Tiny HTTP client for the RareCloud /v1 surface. Same envelope shape
// the CLI + Terraform provider use: { ok: true, data: ... } or
// { ok: false, error: { code, message } }.
//
// Idempotency-Key handling lives here, once, for every tool: a POST made with
// the `idempotent` option on a route the API covers (see idempotency.ts) carries
// the header, and only such a POST is ever retried.

import { randomUUID } from 'node:crypto';
import { SERVER_VERSION } from './version.js';
import {
  isIdempotentPostPath,
  type ReplayInfo,
  IN_PROGRESS_RETRY_AFTER_CAP_SECONDS,
  IN_PROGRESS_MAX_RETRIES,
  GENERATED_KEY_TRANSPORT_RETRIES,
} from './idempotency.js';

export interface RareCloudClientConfig {
  endpoint: string;
  token: string;
  userAgent?: string;
  /** Test seam: how to wait before a retry. Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface APIErrorPayload {
  code: string;
  message: string;
}

/**
 * The guidance an agent gets when the user made a resource read-only for agents
 * and API tokens (HTTP 403 RESOURCE_PROTECTED). The one place it is worded.
 */
export const RESOURCE_PROTECTED_GUIDANCE =
  'The user made this resource read-only for agents and API tokens, so this request was refused and ' +
  'nothing was changed. Agents can still list it and read its details, but cannot change it or read its ' +
  'credentials. Do not retry, and do not try to reach the same result through another tool. If the change ' +
  'is really wanted, ask the user to turn API access on for this resource';

function describeError(payload: APIErrorPayload): string {
  if (payload.code === 'RESOURCE_PROTECTED') {
    const link = /https?:\/\/[^\s"'<>]+/.exec(payload.message ?? '')?.[0]?.replace(/[.,;:)]+$/, '');
    return `[RESOURCE_PROTECTED] ${RESOURCE_PROTECTED_GUIDANCE} in the console${link ? `: ${link}` : '.'}`;
  }
  if (payload.code === 'IDEMPOTENCY_KEY_REUSED') {
    return (
      `[${payload.code}] ${payload.message} Nothing was run. Use a new idempotency_key (or omit it) for a ` +
      'different request; reuse a key only to retry the exact same request.'
    );
  }
  return `[${payload.code}] ${payload.message}`;
}

export interface APIErrorDetails {
  /** HTTP status, when an answer arrived. */
  status?: number;
  /** Retry-After in seconds, when the answer carried one. */
  retryAfterSeconds?: number;
  /** The answer never arrived (network drop, timeout) or a gateway replaced it. */
  transport?: boolean;
}

export class APIError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly transport: boolean;
  constructor(payload: APIErrorPayload, details: APIErrorDetails = {}) {
    super(describeError(payload));
    this.code = payload.code;
    this.status = details.status;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.transport = details.transport ?? false;
  }
}

/** Options for a POST that may carry an Idempotency-Key. */
export interface IdempotentPostOptions {
  /** The agent's own key; when absent one UUIDv4 is generated for this call. */
  key?: string;
  /** Called when the API answered with a replay of an earlier identical request. */
  onReplay?: (info: ReplayInfo) => void;
}

export interface PostOptions {
  /**
   * Send an Idempotency-Key and retry safely. Honoured only on a route the API
   * covers (idempotency.ts); on any other path the POST goes out plain.
   */
  idempotent?: IdempotentPostOptions;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: APIErrorPayload;
  secretsOmittedOnReplay?: unknown;
}

/** Response facts a caller can ask for next to the data (see RareCloudClient.get). */
export interface ResponseMeta {
  /** Categories named by the X-Partial-Results header: the list is incomplete without them. */
  partialResults?: string[];
}

interface DoResult<T> {
  data: T;
  replayed: boolean;
  partialResults: string[];
  secretsOmittedOnReplay: string[];
}

const DEFAULT_IN_PROGRESS_WAIT_SECONDS = 5;
const GATEWAY_STATUSES = new Set([502, 503, 504]);

export class RareCloudClient {
  constructor(private readonly config: RareCloudClientConfig) {}

  async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | undefined>,
    meta?: ResponseMeta,
  ): Promise<T> {
    const url = this.url(path, query);
    const r = await this.do<T>('GET', url);
    if (meta && r.partialResults.length > 0) meta.partialResults = r.partialResults;
    return r.data;
  }

  async post<T = unknown>(path: string, body?: unknown, opts: PostOptions = {}): Promise<T> {
    if (opts.idempotent && isIdempotentPostPath(path)) {
      return this.postIdempotent<T>(path, body, opts.idempotent);
    }
    return (await this.do<T>('POST', this.url(path), body)).data;
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.do<T>('PUT', this.url(path), body)).data;
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.do<T>('PATCH', this.url(path), body)).data;
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return (await this.do<T>('DELETE', this.url(path))).data;
  }

  // One logical operation = one key. A generated key earns one transport retry
  // (the agent cannot retry with a key it never saw); an agent-supplied key gets
  // none (the agent retries with it). IDEMPOTENCY_IN_PROGRESS is waited out a
  // bounded number of times either way. Every other error is final.
  private async postIdempotent<T>(path: string, body: unknown, opts: IdempotentPostOptions): Promise<T> {
    const key = opts.key ?? randomUUID();
    let transportRetries = opts.key === undefined ? GENERATED_KEY_TRANSPORT_RETRIES : 0;
    let inProgressRetries = IN_PROGRESS_MAX_RETRIES;
    const url = this.url(path);
    for (;;) {
      try {
        const r = await this.do<T>('POST', url, body, { 'Idempotency-Key': key });
        if (r.replayed) opts.onReplay?.({ secretsOmittedOnReplay: r.secretsOmittedOnReplay });
        return r.data;
      } catch (e) {
        if (!(e instanceof APIError)) throw e;
        if (e.transport && transportRetries > 0) {
          transportRetries--;
          continue;
        }
        if (e.code === 'IDEMPOTENCY_IN_PROGRESS' && inProgressRetries > 0) {
          inProgressRetries--;
          const secs = Math.min(e.retryAfterSeconds ?? DEFAULT_IN_PROGRESS_WAIT_SECONDS, IN_PROGRESS_RETRY_AFTER_CAP_SECONDS);
          await this.sleep(secs * 1000);
          continue;
        }
        throw e;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.config.sleep) return this.config.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(this.config.endpoint + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async do<T>(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<DoResult<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      'User-Agent': this.config.userAgent ?? `rarecloud-mcp/${SERVER_VERSION}`,
      ...extraHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let resp: Response;
    let text: string;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      text = await resp.text();
    } catch (e) {
      throw new APIError({ code: 'NETWORK_ERROR', message: (e as Error).message }, { transport: true });
    }

    const header = (name: string): string | null => resp.headers?.get?.(name) ?? null;

    let env: Envelope<T>;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new APIError(
        {
          code: 'INVALID_RESPONSE',
          message: `Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`,
        },
        // A gateway timeout/error page in place of the API's answer: the request
        // may or may not have run, exactly like a dropped connection.
        { status: resp.status, transport: GATEWAY_STATUSES.has(resp.status) },
      );
    }

    if (!env.ok) {
      const ra = Number.parseInt(header('Retry-After') ?? '', 10);
      throw new APIError(env.error ?? { code: 'UNKNOWN', message: `HTTP ${resp.status}` }, {
        status: resp.status,
        retryAfterSeconds: Number.isFinite(ra) && ra >= 0 ? ra : undefined,
      });
    }

    const data = (env.data ?? ({} as T)) as T;
    const replayed = header('Idempotent-Replayed')?.toLowerCase() === 'true';
    const omitted = env.secretsOmittedOnReplay ?? (data as { secretsOmittedOnReplay?: unknown } | null)?.secretsOmittedOnReplay;
    const partialResults = (header('X-Partial-Results') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return {
      data,
      replayed,
      partialResults,
      secretsOmittedOnReplay: Array.isArray(omitted) ? omitted.filter((s): s is string => typeof s === 'string') : [],
    };
  }
}

export function clientFromEnv(): RareCloudClient {
  const endpoint = process.env.RARECLOUD_API_ENDPOINT?.replace(/\/$/, '') ?? 'https://api.rarecloud.io';
  const token = process.env.RARECLOUD_API_TOKEN;
  if (!token) {
    throw new APIError({
      code: 'MISSING_TOKEN',
      message: 'Set RARECLOUD_API_TOKEN to your personal access token (Dashboard → Account → API tokens).',
    });
  }
  return new RareCloudClient({ endpoint, token });
}
