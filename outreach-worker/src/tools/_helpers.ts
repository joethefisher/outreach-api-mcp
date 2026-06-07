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
import { AuthError } from "../auth/index.js";
import { isErrorEnvelope, type ErrorEnvelope } from "../errors/envelopes.js";
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
