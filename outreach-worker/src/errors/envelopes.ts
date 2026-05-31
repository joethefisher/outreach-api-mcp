// Structured error envelopes returned to the agent.
//
// Each envelope carries a human-readable `message` the agent can quote, plus
// machine-readable fields for the agent's recovery logic. Adding a new
// envelope means: append to the discriminated union, add a factory, document
// in the system prompt that consumes this server.

export type ErrorEnvelope =
  | NotFoundError
  | AmbiguousMatchError
  | NoResultsError
  | TooLargeError
  | TooManyInputsError
  | RateLimitedError
  | TokenInvalidError
  | OAuthNotConnectedError
  | ScopeMissingError
  | OutreachApiError
  | ValidationError
  | InvalidResourceError
  | TimeoutError
  | NotImplementedError;

export interface NotFoundError {
  readonly error: "notFound";
  readonly resourceType: string;
  readonly id: number | string;
  readonly message: string;
}

export interface AmbiguousMatch {
  readonly id: number | string;
  readonly label: string;
  readonly hint?: string;
}

export interface AmbiguousMatchError {
  readonly error: "ambiguousMatch";
  readonly matches: readonly AmbiguousMatch[];
  readonly message: string;
}

export interface NoResultsError {
  readonly error: "noResults";
  readonly query: Readonly<Record<string, unknown>>;
  readonly suggestions: readonly string[];
  readonly message: string;
}

export interface TooLargeError {
  readonly error: "tooLarge";
  readonly count: number;
  readonly countTruncated?: boolean;
  readonly message: string;
}

export interface TooManyInputsError {
  readonly error: "tooManyInputs";
  readonly limit: number;
  readonly given: number;
  readonly message: string;
}

export interface RateLimitedError {
  readonly error: "rateLimited";
  readonly retryAfterSeconds: number;
  readonly message: string;
}

export interface TokenInvalidError {
  readonly error: "tokenInvalid";
  readonly message: string;
}

export interface OAuthNotConnectedError {
  readonly error: "oauthNotConnected";
  readonly message: string;
}

export interface ScopeMissingError {
  readonly error: "scopeMissing";
  readonly scope: string;
  readonly message: string;
}

export interface OutreachApiError {
  readonly error: "outreachApiError";
  readonly status: number;
  readonly detail?: string;
  readonly message: string;
}

export interface ValidationError {
  readonly error: "validationError";
  readonly detail: string;
  readonly pointer?: string;
  readonly message: string;
}

export interface InvalidResourceError {
  readonly error: "invalidResource";
  readonly given: string;
  readonly allowed: readonly string[];
  readonly message: string;
}

export interface TimeoutError {
  readonly error: "timeout";
  readonly message: string;
}

export interface NotImplementedError {
  readonly error: "notImplemented";
  readonly tool: string;
  readonly message: string;
}

// ─── Factories ────────────────────────────────────────────────────────────

export function notFound(resourceType: string, id: number | string): NotFoundError {
  return {
    error: "notFound",
    resourceType,
    id,
    message: `No ${resourceType} found with ID ${String(id)}.`,
  };
}

export function ambiguousMatch(
  matches: readonly AmbiguousMatch[],
  noun = "match",
): AmbiguousMatchError {
  return {
    error: "ambiguousMatch",
    matches,
    message: `Found ${String(matches.length)} possible ${noun}es. Ask the user which one they meant.`,
  };
}

export function noResults(
  query: Readonly<Record<string, unknown>>,
  suggestions: readonly string[] = [],
): NoResultsError {
  return {
    error: "noResults",
    query,
    suggestions,
    message: "No results matched the query. Try widening the scope or adjusting filters.",
  };
}

export function tooLarge(count: number, countTruncated = false): TooLargeError {
  const message =
    count < 0
      ? "Result set is too large for Outreach to count in one call. Narrow the scope (shorter date range, specific sequence, single rep)."
      : `${countTruncated ? "More than " : ""}${String(count)} records match — too many to fetch in one call. Ask the user to narrow scope (date range, owner, sequence, etc.).`;
  return countTruncated
    ? { error: "tooLarge", count, countTruncated: true, message }
    : { error: "tooLarge", count, message };
}

export function tooManyInputs(limit: number, given: number): TooManyInputsError {
  return {
    error: "tooManyInputs",
    limit,
    given,
    message: `This tool accepts up to ${String(limit)} inputs; got ${String(given)}. Reduce the input count and retry.`,
  };
}

export function rateLimited(retryAfterSeconds: number): RateLimitedError {
  return {
    error: "rateLimited",
    retryAfterSeconds,
    message: `Outreach API rate limit reached. Try again in ${String(retryAfterSeconds)} seconds.`,
  };
}

export function tokenInvalid(): TokenInvalidError {
  return {
    error: "tokenInvalid",
    message:
      "Outreach access token is invalid or has been revoked. Re-run `npm run bootstrap:oauth` to re-authorize.",
  };
}

export function oauthNotConnected(): OAuthNotConnectedError {
  return {
    error: "oauthNotConnected",
    message:
      "OAuth has not been initialized. Run `npm run bootstrap:oauth` to capture a refresh token, then set OUTREACH_REFRESH_TOKEN in .env (or place the token in the cache file).",
  };
}

export function scopeMissing(scope: string): ScopeMissingError {
  return {
    error: "scopeMissing",
    scope,
    message: `This action requires the ${scope} OAuth scope, which is not currently authorized for this token.`,
  };
}

export function outreachApiError(status: number, detail?: string): OutreachApiError {
  const message = `Outreach API returned ${String(status)}${detail !== undefined ? `: ${detail}` : "."}`;
  return detail === undefined
    ? { error: "outreachApiError", status, message }
    : { error: "outreachApiError", status, detail, message };
}

export function validationError(detail: string, pointer?: string): ValidationError {
  const message = `Validation error: ${detail}${pointer !== undefined ? ` (at ${pointer})` : ""}.`;
  return pointer === undefined
    ? { error: "validationError", detail, message }
    : { error: "validationError", detail, pointer, message };
}

export function invalidResource(given: string, allowed: readonly string[]): InvalidResourceError {
  return {
    error: "invalidResource",
    given,
    allowed,
    message: `Resource type "${given}" is not allowed. Allowed: ${allowed.join(", ")}.`,
  };
}

export function timeout(): TimeoutError {
  return {
    error: "timeout",
    message: "Query took longer than expected. Try narrowing the scope.",
  };
}

export function notImplemented(tool: string): NotImplementedError {
  return {
    error: "notImplemented",
    tool,
    message: `Tool "${tool}" is scaffolded but not yet implemented.`,
  };
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}
