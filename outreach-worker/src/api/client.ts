// Unified Outreach HTTP client.
//
// Public shape: `OutreachClient` interface. The production implementation
// (`LiveOutreachClient`) talks to the live Outreach REST API; tests inject a
// mock client via `setOutreachClient()`.
//
// Hot-path responsibilities:
//   - Bearer-token-authenticated `GET` requests via fetch.
//   - Rate-limit observation; back off when nearing the warn threshold.
//   - On 401: invalidate the cached access token, refresh, retry once.
//   - On 429: read Retry-After, wait, retry once.
//   - Translate HTTP status codes to typed error envelopes.
//
// Read-only invariant (STANDARDS.md §2.7): this client only emits `GET`.
// The method is hardcoded on every fetch call; the request helper does not
// accept a method parameter.

import {
  AuthError,
  getAccessToken as defaultGetAccessToken,
  invalidateAccessToken as defaultInvalidateAccessToken,
} from "../auth/index.js";
import { loadRuntimeConfig } from "../config/index.js";
import {
  outreachApiError,
  rateLimited,
  scopeMissing,
  tokenInvalid,
  type ErrorEnvelope,
} from "../errors/envelopes.js";
import { logger } from "../logger.js";
import { buildQueryString, type FilterMap, type ListQuery } from "./filters.js";
import {
  extractNextCursor,
  normalizeDocument,
  type FlattenMap,
  type JsonApiDocument,
} from "./jsonapi.js";
import { parseRetryAfter, RateLimitTracker } from "./rateLimit.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ListOptions extends ListQuery {
  readonly flatten?: FlattenMap;
}

export interface ListResult<T = Record<string, unknown>> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  readonly count?: number;
  readonly countTruncated?: boolean;
}

export interface GetOptions {
  readonly includes?: readonly string[];
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly flatten?: FlattenMap;
}

export interface OutreachUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly title?: string;
  readonly locked?: boolean;
  readonly createdAt?: string;
}

export interface OutreachClient {
  list<T = Record<string, unknown>>(
    resource: string,
    options?: ListOptions,
  ): Promise<ListResult<T>>;

  get<T = Record<string, unknown>>(
    resource: string,
    id: number | string,
    options?: GetOptions,
  ): Promise<T>;

  count(
    resource: string,
    filters?: FilterMap,
  ): Promise<{ readonly count: number; readonly truncated: boolean }>;

  listUsers(): Promise<readonly OutreachUser[]>;

  fetchTypes(): Promise<unknown>;
}

/** Thrown when an Outreach request fails with a structured envelope. */
export class OutreachApiException extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = "OutreachApiException";
  }
}

export interface LiveOutreachClientOptions {
  readonly apiBase: string;
  /** Token provider. Defaults to the singleton auth module. Injectable for tests. */
  readonly getAccessToken?: () => Promise<string>;
  /** Invalidates the cached access token on 401. Injectable for tests. */
  readonly invalidateAccessToken?: () => void;
  /** Injectable fetch. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

// ─── Live implementation ─────────────────────────────────────────────────────

export class LiveOutreachClient implements OutreachClient {
  private readonly rateLimit = new RateLimitTracker();
  private readonly apiBase: string;
  private readonly getAccessTokenImpl: () => Promise<string>;
  private readonly invalidateAccessTokenImpl: () => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LiveOutreachClientOptions) {
    this.apiBase = opts.apiBase;
    this.getAccessTokenImpl = opts.getAccessToken ?? defaultGetAccessToken;
    this.invalidateAccessTokenImpl = opts.invalidateAccessToken ?? defaultInvalidateAccessToken;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async list<T = Record<string, unknown>>(
    resource: string,
    options: ListOptions = {},
  ): Promise<ListResult<T>> {
    const queryString = buildQueryString(options);
    const path = `/${pluralize(resource)}`;
    const doc = await this.fetchDocument(path, queryString);
    const normalized = normalizeDocument(doc, options.flatten ?? {});
    const data = Array.isArray(normalized.data) ? (normalized.data as T[]) : [];
    const nextCursor = extractNextCursor(doc.links);
    const result: ListResult<T> = {
      data,
      nextCursor,
      ...(doc.meta?.count !== undefined && { count: doc.meta.count }),
      ...(doc.meta?.count_truncated !== undefined && {
        countTruncated: doc.meta.count_truncated,
      }),
    };
    return result;
  }

  async get<T = Record<string, unknown>>(
    resource: string,
    id: number | string,
    options: GetOptions = {},
  ): Promise<T> {
    const params = new URLSearchParams();
    if (options.includes !== undefined && options.includes.length > 0) {
      params.append("include", options.includes.join(","));
    }
    if (options.fields !== undefined) {
      for (const [type, list] of Object.entries(options.fields)) {
        if (list.length > 0) params.append(`fields[${type}]`, list.join(","));
      }
    }
    const path = `/${pluralize(resource)}/${String(id)}`;
    const doc = await this.fetchDocument(path, params.toString());
    if (doc.data === undefined) {
      const { notFound } = await import("../errors/envelopes.js");
      throw new OutreachApiException(notFound(resource, id));
    }
    const normalized = normalizeDocument(doc, options.flatten ?? {});
    return normalized.data as T;
  }

  async count(
    resource: string,
    filters?: FilterMap,
  ): Promise<{ readonly count: number; readonly truncated: boolean }> {
    // `?count=true` over a 1-record page is the cheapest way to get a count.
    // Outreach has no count-only endpoint.
    const result = await this.list(resource, {
      ...(filters !== undefined && { filters }),
      pageSize: 1,
      count: true,
    });
    return {
      count: result.count ?? 0,
      truncated: result.countTruncated === true,
    };
  }

  async listUsers(): Promise<readonly OutreachUser[]> {
    const result = await this.list<{
      id: number;
      firstName?: string;
      lastName?: string;
      email?: string;
      title?: string;
      locked?: boolean;
      createdAt?: string;
    }>("user", {
      fields: { user: ["firstName", "lastName", "email", "title", "locked", "createdAt"] },
      pageSize: 100,
    });
    return result.data.map((u): OutreachUser => {
      const base = {
        id: u.id,
        name: [u.firstName, u.lastName].filter((p): p is string => p !== undefined).join(" "),
        email: u.email ?? "",
      };
      return {
        ...base,
        ...(u.title !== undefined && { title: u.title }),
        ...(u.locked !== undefined && { locked: u.locked }),
        ...(u.createdAt !== undefined && { createdAt: u.createdAt }),
      };
    });
  }

  async fetchTypes(): Promise<unknown> {
    const response = await this.requestWithRetries("/types", "");
    if (!response.ok) {
      const text = await response.text();
      throw new OutreachApiException(outreachApiError(response.status, text.slice(0, 200)));
    }
    return response.json();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async fetchDocument(path: string, queryString: string): Promise<JsonApiDocument> {
    const response = await this.requestWithRetries(path, queryString);
    if (response.status === 404) {
      // Caller checks `doc.data === undefined` and maps to `notFound`.
      return {};
    }
    if (!response.ok) {
      const text = await response.text();
      throw new OutreachApiException(outreachApiError(response.status, text.slice(0, 200)));
    }
    return (await response.json()) as JsonApiDocument;
  }

  /**
   * Issue a GET with the access token attached, observing rate limits and
   * retrying once on 401 (after force-refreshing the token) or 429 (after
   * waiting Retry-After). Any other failure surfaces immediately.
   */
  private async requestWithRetries(path: string, queryString: string): Promise<Response> {
    // 1) Soft-throttle if we're near the rate-limit warn band.
    const delay = this.rateLimit.recommendDelaySeconds();
    if (delay > 0) {
      logger.debug("api.rateLimit.pace", { delaySeconds: delay });
      await sleep(delay * 1000);
    }

    // 2) First attempt.
    let response = await this.attempt(path, queryString);

    // 3) On 401, force-refresh the token and retry once.
    if (response.status === 401) {
      logger.info("api.401.refreshing");
      this.invalidateAccessTokenImpl();
      response = await this.attempt(path, queryString);
    }

    // 4) On 429, wait Retry-After and retry once.
    if (response.status === 429) {
      const wait = parseRetryAfter(response.headers);
      logger.warn("api.429.retrying", { waitSeconds: wait });
      await sleep(wait * 1000);
      response = await this.attempt(path, queryString);
      if (response.status === 429) {
        throw new OutreachApiException(rateLimited(parseRetryAfter(response.headers)));
      }
    }

    // 5) Translate terminal status codes to envelopes.
    if (response.status === 401) {
      throw new OutreachApiException(tokenInvalid());
    }
    if (response.status === 403) {
      const text = await response.text();
      const scope = extractMissingScope(text);
      throw new OutreachApiException(
        scope !== null ? scopeMissing(scope) : outreachApiError(403, text.slice(0, 200)),
      );
    }
    return response;
  }

  private async attempt(path: string, queryString: string): Promise<Response> {
    let accessToken: string;
    try {
      accessToken = await this.getAccessTokenImpl();
    } catch (e) {
      if (e instanceof AuthError) throw new OutreachApiException(e.envelope);
      throw e;
    }
    const url = `${this.apiBase}${path}${queryString === "" ? "" : `?${queryString}`}`;
    // Log path only — query strings include filter values that may be PII.
    logger.debug("api.request", { path });
    const response = await this.fetchImpl(url, {
      // Read-only invariant: GET is the only method this client ever emits.
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
    });
    this.rateLimit.observe(response.headers);
    return response;
  }
}

// ─── Factory + test seams ────────────────────────────────────────────────────

let cached: OutreachClient | null = null;

export function getOutreachClient(): OutreachClient {
  if (cached !== null) return cached;
  const cfg = loadRuntimeConfig();
  cached = new LiveOutreachClient({ apiBase: cfg.apiBase });
  return cached;
}

/** Inject a custom client (tests; or future in-process mock modes). */
export function setOutreachClient(client: OutreachClient): void {
  cached = client;
}

export function resetOutreachClient(): void {
  cached = null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract a missing-scope identifier from a 403 body. Outreach uses several
 * shapes; the strict pattern (`<scope>.read`) wins, then a "resources:" form
 * common to include errors, then a loose fallback.
 */
function extractMissingScope(body: string): string | null {
  const explicit = /["']([\w.]+\.(?:read|write|all))["']/i.exec(body);
  if (explicit?.[1] !== undefined) return explicit[1];
  const resourceMatch = /(?:read the following |read )resources?:\s*([\w.]+)/i.exec(body);
  if (resourceMatch?.[1] !== undefined) {
    return `${resourceMatch[1].replace(/[.,;]+$/, "")}.read`;
  }
  const loose = /\b([\w]+\.(?:read|write|all))\b/i.exec(body);
  if (loose?.[1] !== undefined && !/^missing\./i.test(loose[1])) return loose[1];
  return null;
}

// Resource → URL plural mapping. Most are +s; the exceptions live here.
const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  opportunity: "opportunities",
  opportunityStage: "opportunityStages",
  opportunityProspectRole: "opportunityProspectRoles",
  mailbox: "mailboxes",
  taskPurpose: "taskPurposes",
  callPurpose: "callPurposes",
};

function pluralize(resource: string): string {
  const irregular = IRREGULAR_PLURALS[resource];
  if (irregular !== undefined) return irregular;
  if (resource.endsWith("y") && !/[aeiou]y$/.test(resource)) {
    return `${resource.slice(0, -1)}ies`;
  }
  return `${resource}s`;
}
