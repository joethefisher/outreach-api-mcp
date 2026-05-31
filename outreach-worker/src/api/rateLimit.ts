// Rate-limit header tracking + soft-throttle helper.
//
// Outreach returns X-RateLimit-Limit / -Remaining / -Reset on every response.
// When remaining drops below WARN_THRESHOLD_PCT percent of the limit, we
// recommend a per-request delay spaced evenly across the time to reset to
// avoid burning through the bucket and getting a 429.
//
// On a 429, the API client reads `Retry-After`, waits, and retries once;
// see api/client.ts.

/** Below this percentage of remaining capacity, we pace requests. */
const WARN_THRESHOLD_PCT = 10;

/** Fallback wait when Retry-After is absent or unparseable. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface RateLimitState {
  readonly limit: number;
  readonly remaining: number;
  /** Unix seconds when the bucket resets. */
  readonly resetAt: number;
}

/** Lookup that works against both Headers and plain object representations. */
function readHeader(
  headers: Headers | Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return headers[name] ?? headers[name.toLowerCase()];
}

export class RateLimitTracker {
  private state: RateLimitState | null = null;

  observe(headers: Headers | Readonly<Record<string, string | undefined>> | null): void {
    if (headers === null) return;
    const limit = Number(readHeader(headers, "X-RateLimit-Limit"));
    const remaining = Number(readHeader(headers, "X-RateLimit-Remaining"));
    const reset = Number(readHeader(headers, "X-RateLimit-Reset"));
    if (Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.state = { limit, remaining, resetAt: reset };
    }
  }

  /** Seconds to wait before the next call to stay under the warn threshold. */
  recommendDelaySeconds(now: number = Math.floor(Date.now() / 1000)): number {
    const state = this.state;
    if (state === null) return 0;
    const pctRemaining = (state.remaining / state.limit) * 100;
    if (pctRemaining > WARN_THRESHOLD_PCT) return 0;
    const secsUntilReset = Math.max(0, state.resetAt - now);
    if (state.remaining <= 0) return secsUntilReset;
    return Math.max(0, secsUntilReset / state.remaining);
  }

  current(): RateLimitState | null {
    return this.state;
  }
}

/**
 * Parse Retry-After (seconds form). Falls back to DEFAULT_RETRY_AFTER_SECONDS
 * when the header is absent or unparseable. HTTP-date form is rare for
 * Outreach and treated as the fallback.
 */
export function parseRetryAfter(headers: Headers | null): number {
  if (headers === null) return DEFAULT_RETRY_AFTER_SECONDS;
  const raw = headers.get("Retry-After") ?? headers.get("retry-after");
  if (raw === null || raw === "") return DEFAULT_RETRY_AFTER_SECONDS;
  const n = Number(raw);
  // Per RFC 7231, Retry-After delay-seconds is a non-negative decimal integer.
  // 0 means "retry immediately" — accept it.
  if (Number.isFinite(n) && n >= 0) return n;
  return DEFAULT_RETRY_AFTER_SECONDS;
}
