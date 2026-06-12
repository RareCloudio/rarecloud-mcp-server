// Tiny HTTP client for the RareCloud /v1 surface. Same envelope shape
// the CLI + Terraform provider use: { ok: true, data: ... } or
// { ok: false, error: { code, message } }.

export interface RareCloudClientConfig {
  endpoint: string;
  token: string;
  userAgent?: string;
}

export interface APIErrorPayload {
  code: string;
  message: string;
}

export class APIError extends Error {
  readonly code: string;
  constructor(payload: APIErrorPayload) {
    super(`[${payload.code}] ${payload.message}`);
    this.code = payload.code;
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: APIErrorPayload;
}

export class RareCloudClient {
  constructor(private readonly config: RareCloudClientConfig) {}

  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.url(path, query);
    return this.do<T>('GET', url);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.do<T>('POST', this.url(path), body);
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.do<T>('DELETE', this.url(path));
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

  private async do<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      'User-Agent': this.config.userAgent ?? 'rarecloud-mcp/0.1.0',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new APIError({ code: 'NETWORK_ERROR', message: (e as Error).message });
    }

    const text = await resp.text();
    let env: Envelope<T>;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new APIError({
        code: 'INVALID_RESPONSE',
        message: `Non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`,
      });
    }

    if (!env.ok) {
      throw new APIError(env.error ?? { code: 'UNKNOWN', message: `HTTP ${resp.status}` });
    }
    return (env.data ?? ({} as T)) as T;
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
