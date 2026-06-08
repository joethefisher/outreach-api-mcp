// Structured stderr logger.
//
// Stdout is reserved for MCP JSON-RPC frames (see STANDARDS.md §2.1 and
// SECURITY.md). Every log line goes to stderr via `process.stderr.write`.
// `console.log` is forbidden across the codebase by lint.
//
// Defense in depth (SEC-01, NEW-3): `emit()` always calls `redact(ctx)`
// before serialization. Callers DO NOT need to remember to wrap their
// payload — known-sensitive keys are masked, every string leaf is run
// through the value scrubber (Bearer / OAuth-form / JWT), and a
// circular-reference guard prevents stack overflow. Adding a new
// always-sensitive key is part of the PR that introduces it.
//
// Level is configured explicitly by the entry point via `configureLogger()`.
// The module starts at "info" and never reads env directly; that avoids any
// import-time ordering bugs with `config/`.

import type { LogLevel } from "./config/index.js";

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentThreshold: number = LEVEL_WEIGHTS.info;

export function configureLogger(level: LogLevel): void {
  currentThreshold = LEVEL_WEIGHTS[level];
}

export interface Logger {
  debug(msg: string, ctx?: Readonly<Record<string, unknown>>): void;
  info(msg: string, ctx?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, ctx?: Readonly<Record<string, unknown>>): void;
  error(msg: string, ctx?: Readonly<Record<string, unknown>>): void;
}

export const logger: Logger = {
  debug: (msg, ctx = {}) => {
    emit("debug", msg, ctx);
  },
  info: (msg, ctx = {}) => {
    emit("info", msg, ctx);
  },
  warn: (msg, ctx = {}) => {
    emit("warn", msg, ctx);
  },
  error: (msg, ctx = {}) => {
    emit("error", msg, ctx);
  },
};

function emit(level: LogLevel, msg: string, ctx: Readonly<Record<string, unknown>>): void {
  if (LEVEL_WEIGHTS[level] < currentThreshold) return;
  // SEC-01 / NEW-3: redact is applied here unconditionally so a caller that
  // forgets to scrub their own payload still emits a safe line. Belt-and-
  // suspenders: `tools/_helpers.ts:runTool` ALSO redacts before calling.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...redact(ctx),
  });
  process.stderr.write(`${line}\n`);
}

// Sensitive keys redacted automatically. Covers OAuth credentials, bearer
// tokens, PKCE artifacts, and personally-identifying Outreach fields. Adding
// a new sensitive key is part of the PR that introduces it.
//
// SEC-02: bare generic names (`state`, `code`, `token`, `bearer`) were
// previously here as defense-in-depth, but they over-redact normal Outreach
// payloads — `sequenceState.state: "active"`, `country.code: "US"`, an audit
// field named `token`. The value scrubbers below still catch the actual
// secret shapes (Bearer headers, JWTs, OAuth/PKCE form fields), so we keep
// only OAuth-specific keys here.
const REDACT_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "refresh_token",
  "client_secret",
  "authorization",
  "Authorization",
  "code_verifier",
  "emails",
  "phoneNumbers",
  "bodyHtml",
  "bodyText",
]);

// Value-shaped patterns scrubbed regardless of the key the string appears
// under (SEC-01). Catches tokens that leak via upstream error bodies
// (api/client.ts puts the first 200 chars of a 4xx/5xx body into
// outreachApiError.detail), values in user-supplied filters that the agent
// echoes back through noResults, and any other path where a token-shaped
// string reaches a non-sensitive key.
//
// NEW-4: shape-based scrubbing cannot identify opaque random-string tokens
// that don't match a recognized shape (e.g. a 16-char alphanumeric API key
// with no `Bearer ` prefix and no JWT segments). Such values must be
// redacted at the key level via REDACT_KEYS, or kept out of log payloads
// entirely. The runTool wrapper redacts tool inputs by key on the way in.
//
// NEW-5: the form scrubber is split. OAuth-specific field names
// (access_token, refresh_token, client_secret, code_verifier) are unique
// enough to always scrub. The previously-broad bare names — `code`,
// `state`, `token`, `bearer` — only fire when the surrounding string
// carries an OAuth/PKCE/token-response marker (per RFC 6749 / RFC 7636).
// That keeps "promo code=ABC123" and "track state=enabled" out of the
// scrubber's path while still catching real OAuth bodies, which always
// carry one of these markers.
const OAUTH_CONTEXT_RE =
  /(?:grant_type|client_id|redirect_uri|code_challenge|code_challenge_method|token_type|expires_in|error)=/i;
const OAUTH_FORM_FIELD_ALWAYS_RE =
  /(access_token|refresh_token|client_secret|code_verifier)=([^&\s"']+)/gi;
const OAUTH_FORM_FIELD_CONTEXT_RE = /(code|state|token|bearer)=([^&\s"']+)/gi;
const VALUE_SCRUBBERS: readonly RegExp[] = [
  // OAuth bearer header value.
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  // JWT-shaped values (three base64url segments separated by `.`).
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

function scrubString(value: string): string {
  let out = value;
  for (const pattern of VALUE_SCRUBBERS) out = out.replace(pattern, "[REDACTED]");
  out = out.replace(OAUTH_FORM_FIELD_ALWAYS_RE, "$1=[REDACTED]");
  if (OAUTH_CONTEXT_RE.test(out)) out = out.replace(OAUTH_FORM_FIELD_CONTEXT_RE, "$1=[REDACTED]");
  return out;
}

export function redact<T>(input: T): T {
  return redactValue(input, new WeakSet()) as T;
}

function redactValue(input: unknown, seen: WeakSet<object>): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return scrubString(input);
  if (typeof input !== "object") return input;
  // SEC-06 circular-reference guard.
  //
  // NEW-6: track only nodes on the *current path* through the graph. A
  // sibling reference to the same shared, acyclic object should be
  // redacted normally, not collapsed to "[Circular]". We add on the way
  // down and delete on the way back up so `seen` represents the active
  // call stack, not every node we've ever visited.
  if (seen.has(input)) return "[Circular]";
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      return input.map((entry: unknown) => redactValue(entry, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = REDACT_KEYS.has(key) ? "[REDACTED]" : redactValue(value, seen);
    }
    return out;
  } finally {
    seen.delete(input);
  }
}
