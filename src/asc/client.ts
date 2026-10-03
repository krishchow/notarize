import { ToolError } from "../core/result";
import type { AscTokenProvider } from "./auth";

export const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";

export interface AscRelationship {
  data?: { type: string; id: string } | { type: string; id: string }[] | null;
  links?: { self?: string; related?: string };
  meta?: Record<string, unknown>;
}

export interface AscResource<A = Record<string, any>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, AscRelationship>;
  links?: { self?: string };
}

export interface AscDocument<T> {
  data: T;
  included?: AscResource[];
  links?: { self?: string; next?: string; first?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export interface AscErrorEntry {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export interface RateLimit {
  limit?: number;
  remaining?: number;
}

export class AscApiError extends ToolError {
  constructor(
    readonly status: number,
    readonly errors: AscErrorEntry[],
    readonly method: string,
    readonly path: string,
  ) {
    const first = errors[0];
    const msg = first
      ? `${first.title ?? first.code ?? "Error"}${first.detail ? `: ${first.detail}` : ""}`
      : `HTTP ${status}`;
    super(`App Store Connect API ${method} ${path} failed (${status}): ${msg}`, {
      hint: explainAscError(status, errors),
      data: { status, errors },
    });
    this.name = "AscApiError";
  }
}

export function explainAscError(status: number, errors: AscErrorEntry[]): string | undefined {
  const text = errors
    .map((e) => `${e.code ?? ""} ${e.title ?? ""} ${e.detail ?? ""}`)
    .join(" ")
    .toLowerCase();
  if (status === 401) {
    return "Authentication failed: check the Key ID and Issuer ID match the .p8, that the key has not been revoked, and that this Mac's clock is correct (JWTs are time-limited).";
  }
  if (status === 403) {
    if (text.includes("agreement")) {
      return "A required agreement has not been accepted. The Account Holder must sign in to developer.apple.com / App Store Connect → Business and accept the updated agreement(s); the API is blocked until then.";
    }
    return "The API key's role does not allow this. Signing assets (certificates, profiles, bundle IDs) need Admin or App Manager (Developer ID certificates usually need the Account Holder, via the web portal). TestFlight/App Store changes need App Manager or Admin.";
  }
  if (status === 404) return "Resource not found — check the ID, or that it belongs to this team.";
  if (status === 409) {
    if (text.includes("already exists") || text.includes("duplicate")) {
      return "The resource already exists (identifiers must be unique across ALL Apple teams). List existing resources or pick a different identifier.";
    }
    if (text.includes("maximum") || text.includes("limit")) {
      return "A per-team limit was reached (e.g. certificates of this type). Reuse an existing one or revoke an unused one in the portal.";
    }
    return "The request conflicts with the current state or has invalid values; read the detail and source.pointer.";
  }
  if (status === 429) return "Rate limited (Apple allows ~3600 requests/hour per key). Wait and retry.";
  if (status >= 500)
    return "Apple's service had an error; retry shortly. Check https://developer.apple.com/system-status/.";
  return undefined;
}

export interface AscClientOptions {
  tokens: AscTokenProvider;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class AscClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  lastRateLimit?: RateLimit;

  constructor(private readonly opts: AscClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? ASC_BASE_URL;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get keyId(): string {
    return this.opts.tokens.keyId;
  }

  url(path: string, query?: Query): string {
    const u = path.startsWith("http")
      ? new URL(path)
      : new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    if (!/^\/v\d+\//.test(u.pathname)) u.pathname = `/v1${u.pathname}`;
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === "") continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return u.toString();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ status: number; body: T; rateLimit?: RateLimit }> {
    const url = this.url(path, opts.query);
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.tokens.token();
      const res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const rateLimit = parseRateLimit(res.headers.get("x-rate-limit"));
      if (rateLimit) this.lastRateLimit = rateLimit;
      const text = await res.text();
      let body: any;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      if (res.ok) return { status: res.status, body: body as T, rateLimit };
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      const errors: AscErrorEntry[] = Array.isArray(body?.errors)
        ? body.errors
        : [{ status: String(res.status), detail: typeof body === "string" ? body.slice(0, 500) : undefined }];
      throw new AscApiError(res.status, errors, method, new URL(url).pathname);
    }
  }

  async get<T = AscResource>(path: string, query?: Query): Promise<AscDocument<T>> {
    return (await this.request<AscDocument<T>>("GET", path, { query })).body;
  }

  /** GET a collection, following `links.next` up to `maxItems`. */
  async list<A = Record<string, any>>(
    path: string,
    query: Query = {},
    maxItems = 200,
  ): Promise<{ data: AscResource<A>[]; included: AscResource[]; total?: number; truncated: boolean }> {
    const data: AscResource<A>[] = [];
    const included: AscResource[] = [];
    let total: number | undefined;
    let next: string | undefined = this.url(path, { limit: Math.min(200, maxItems), ...query });
    while (next && data.length < maxItems) {
      const doc: AscDocument<AscResource<A>[]> = (
        await this.request<AscDocument<AscResource<A>[]>>("GET", next)
      ).body;
      data.push(...(doc.data ?? []));
      included.push(...(doc.included ?? []));
      total ??= doc.meta?.paging?.total;
      next = doc.links?.next;
    }
    return { data: data.slice(0, maxItems), included, total, truncated: !!next || data.length > maxItems };
  }

  async post<T = AscResource>(path: string, body: unknown): Promise<AscDocument<T>> {
    return (await this.request<AscDocument<T>>("POST", path, { body })).body;
  }

  async patch<T = AscResource>(path: string, body: unknown): Promise<AscDocument<T>> {
    return (await this.request<AscDocument<T>>("PATCH", path, { body })).body;
  }

  async delete(path: string, body?: unknown): Promise<void> {
    await this.request("DELETE", path, { body });
  }
}

export function parseRateLimit(header: string | null): RateLimit | undefined {
  if (!header) return undefined;
  const lim = /user-hour-lim:(\d+)/.exec(header)?.[1];
  const rem = /user-hour-rem:(\d+)/.exec(header)?.[1];
  if (!lim && !rem) return undefined;
  return { limit: lim ? Number(lim) : undefined, remaining: rem ? Number(rem) : undefined };
}

/** Build a JSON:API relationship payload. */
export function rel(type: string, id: string): { data: { type: string; id: string } } {
  return { data: { type, id } };
}

export function relMany(type: string, ids: string[]): { data: { type: string; id: string }[] } {
  return { data: ids.map((id) => ({ type, id })) };
}

/** Compact a resource for tool output (id + attributes, no links noise). */
export function slim<A>(r: AscResource<A>): { id: string; type: string } & Partial<A> {
  return { id: r.id, type: r.type, ...(r.attributes ?? ({} as A)) };
}
