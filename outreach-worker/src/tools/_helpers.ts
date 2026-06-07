// Shared tool-execution scaffolding.
//
// Every tool's implementation is wrapped in `runTool(name, input, fn)`. The
// wrapper:
//   - resolves the singleton OutreachClient
//   - ensures the schema cache is loaded
//   - converts thrown OutreachApiException / AuthError into JSON-string envelopes
//   - serializes successful results as pretty-printed JSON for MCP text content
//   - emits one structured log entry per call
//
// Tools never return raw objects — they always return the JSON string the
// MCP server forwards as text content to the agent.

import { getOutreachClient, OutreachApiException, type OutreachClient } from "../api/client.js";
import type { FilterMap } from "../api/filters.js";
import { AuthError } from "../auth/index.js";
import {
  isErrorEnvelope,
  validationError,
  type ErrorEnvelope,
  type ValidationError,
} from "../errors/envelopes.js";
import { logger, redact } from "../logger.js";
import { type CustomFieldSchemaCache, getSchemaCache } from "../schema/customFields.js";

export interface ToolContext {
  readonly client: OutreachClient;
  readonly schema: CustomFieldSchemaCache;
}

let cachedContext: ToolContext | null = null;

/**
 * Build (or reuse) a ToolContext with a loaded schema cache. Idempotent.
 * Tests can call `resetToolContext()` between runs.
 */
export async function getToolContext(): Promise<ToolContext> {
  if (cachedContext !== null) {
    await cachedContext.schema.ensureLoaded();
    return cachedContext;
  }
  const client = getOutreachClient();
  const schema = getSchemaCache(client);
  await schema.ensureLoaded();
  cachedContext = { client, schema };
  return cachedContext;
}

export function resetToolContext(): void {
  cachedContext = null;
}

/** Test seam — inject a pre-built context. */
export function setToolContext(context: ToolContext): void {
  cachedContext = context;
}

/**
 * Wrap a tool's logic so:
 *   - the result is serialized as JSON
 *   - thrown OutreachApiException / AuthError → its envelope as JSON
 *   - any other thrown value → outreachApiError envelope
 *   - one structured log line per call (input redacted)
 */
export async function runTool<T>(
  toolName: string,
  input: unknown,
  fn: (ctx: ToolContext) => Promise<T>,
): Promise<string> {
  const startedAt = Date.now();
  try {
    const ctx = await getToolContext();
    const result = await fn(ctx);
    const totalMs = Date.now() - startedAt;
    if (isErrorEnvelope(result)) {
      logger.info("tool.invocation", {
        tool: toolName,
        input: redact(input),
        result: "error",
        // SEC-01: the envelope may carry echoed user input (e.g. noResults
        // wraps the original `query`/`filters`). Redact it on the way out so
        // the value-scrubber catches any token-shaped string.
        errorEnvelope: redact(result),
        totalMs,
      });
      return JSON.stringify(result, null, 2);
    }
    logger.info("tool.invocation", {
      tool: toolName,
      input: redact(input),
      result: "success",
      totalMs,
    });
    return JSON.stringify(result, null, 2);
  } catch (e) {
    const envelope = exceptionToEnvelope(e);
    const totalMs = Date.now() - startedAt;
    logger.warn("tool.invocation.error", {
      tool: toolName,
      input: redact(input),
      result: "error",
      // SEC-01: same reason as the success-path branch above.
      errorEnvelope: redact(envelope),
      totalMs,
    });
    return JSON.stringify(envelope, null, 2);
  }
}

function exceptionToEnvelope(e: unknown): ErrorEnvelope {
  if (e instanceof OutreachApiException) return e.envelope;
  if (e instanceof AuthError) return e.envelope;
  const message = e instanceof Error ? e.message : String(e);
  return {
    error: "outreachApiError",
    status: 0,
    detail: message,
    message: `Tool failed unexpectedly: ${message}`,
  };
}

/** ISO-date util: today as YYYY-MM-DD. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** N days ago as YYYY-MM-DD. */
export function daysAgoISO(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Profile-URL plural map mirrors the API's URL pluralization for the web app.
const URL_PATH_PLURALS: Readonly<Record<string, string>> = {
  opportunity: "opportunities",
  account: "accounts",
  prospect: "prospects",
  sequence: "sequences",
  template: "templates",
  snippet: "snippets",
  task: "tasks",
  mailing: "mailings",
  call: "calls",
  user: "users",
};

/** Build an Outreach web-app URL for a given resource type and ID. */
export function profileUrl(resourceType: string, id: number | string): string {
  const path = URL_PATH_PLURALS[resourceType] ?? `${resourceType}s`;
  return `https://web.outreach.io/${path}/${String(id)}`;
}

// ─── Date range validation (COR-08) ──────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidatedDateRange {
  readonly from: string | null;
  readonly to: string | null;
}

export type DateRangeValidationResult =
  | { readonly ok: true; readonly range: ValidatedDateRange }
  | { readonly ok: false; readonly envelope: ValidationError };

/**
 * Validate optional `dateRangeFrom` / `dateRangeTo` inputs. Each is allowed
 * to be missing (returned as `null`); when present, it must match
 * `YYYY-MM-DD`. When both are present, `from` must be on or before `to`.
 *
 * Returns a `validationError` envelope on any failure so the caller can
 * surface a precise message without `new Date()` ever touching unvalidated
 * input. Callers apply their own defaults to a missing side (e.g. `from =
 * range.from ?? daysAgoISO(30)`).
 */
export function validateDateRange(
  from: string | null | undefined,
  to: string | null | undefined,
): DateRangeValidationResult {
  const f = from !== null && from !== undefined && from !== "" ? from : null;
  const t = to !== null && to !== undefined && to !== "" ? to : null;
  if (f !== null) {
    const err = checkIsoDate(f, "dateRangeFrom");
    if (err !== null) return { ok: false, envelope: err };
  }
  if (t !== null) {
    const err = checkIsoDate(t, "dateRangeTo");
    if (err !== null) return { ok: false, envelope: err };
  }
  if (f !== null && t !== null && f > t) {
    return {
      ok: false,
      envelope: validationError(`dateRangeFrom (${f}) must be on or before dateRangeTo (${t}).`),
    };
  }
  return { ok: true, range: { from: f, to: t } };
}

function checkIsoDate(value: string, field: string): ValidationError | null {
  if (!ISO_DATE_RE.test(value)) {
    return validationError(
      `${field} must be an ISO date in YYYY-MM-DD form. Got: "${value}".`,
      field,
    );
  }
  // Round-trip catches calendar invalids the regex passes (e.g. 2026-13-01,
  // 2026-02-30): Date.parse normalizes them to a different day, so the
  // re-serialized prefix won't match the input.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return validationError(`${field} is not a real calendar date: "${value}".`, field);
  }
  return null;
}

/**
 * Paginate `client.list` across multiple pages with a hard cap on pages
 * walked. Returns concatenated data + a `truncated` flag set when the
 * upstream had more pages but we stopped at the cap (COR-07).
 *
 * Tools that need "all of X up to a sane ceiling" (roster, resolver scans)
 * use this instead of a single 500/1000-row call that silently caps.
 */
export interface PaginateListOptions {
  readonly filters?: FilterMap;
  readonly includes?: readonly string[];
  readonly fields?: Record<string, readonly string[]>;
  readonly flatten?: Record<string, readonly string[]>;
  readonly pageSize?: number;
  readonly sort?: string;
  readonly maxPages?: number;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is specified at the call site (resolver-shape vs roster-shape) and propagates into the returned readonly T[]; the rule misses cross-call-site inference benefit.
export async function paginateList<T extends Record<string, unknown>>(
  client: OutreachClient,
  resource: string,
  options: PaginateListOptions,
): Promise<{ readonly data: readonly T[]; readonly truncated: boolean }> {
  const maxPages = options.maxPages ?? 10;
  const data: T[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  let truncated = false;
  for (;;) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const page = await client.list<T>(resource, {
      ...(options.filters !== undefined && { filters: options.filters }),
      ...(options.includes !== undefined && { includes: options.includes }),
      ...(options.fields !== undefined && { fields: options.fields }),
      ...(options.flatten !== undefined && { flatten: options.flatten }),
      ...(options.pageSize !== undefined && { pageSize: options.pageSize }),
      ...(options.sort !== undefined && { sort: options.sort }),
      ...(cursor !== null && cursor !== undefined && cursor !== "" && { cursor }),
    });
    data.push(...page.data);
    pages++;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { data, truncated };
}

/**
 * Wrap an optional sub-fetch so it degrades into the caller's
 * `unavailableSections` instead of collapsing the whole composing tool when
 * the upstream throws (`scopeMissing`, `outreachApiError`, `tokenInvalid`,
 * `timeout`, etc.).
 *
 * Only degrades on **domain** failures — `OutreachApiException` and
 * `AuthError`. Programmer mistakes (a `TypeError` in the call setup, a
 * `RangeError`, a fixture wiring bug in tests) MUST propagate so they are
 * visible as bugs rather than silently mislabelled "section unavailable"
 * (NEW-8). Mirrors the discrimination `getSequenceProfile` already uses on
 * its inner try/catch blocks.
 */
export function optionalFetch<T>(
  fetch: Promise<T>,
  label: string,
  fallback: T,
  unavailableSections: string[],
): Promise<T> {
  return fetch.catch((e: unknown) => {
    if (e instanceof OutreachApiException || e instanceof AuthError) {
      const reason = e.envelope.message;
      unavailableSections.push(`${label}: ${reason}`);
      return fallback;
    }
    // Not a domain error — surface it so the caller can see the bug.
    throw e;
  });
}
