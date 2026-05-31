// Structured stderr logger.
//
// Stdout is reserved for MCP JSON-RPC frames (see STANDARDS.md §2.1 and
// SECURITY.md). Every log line goes to stderr via `process.stderr.write`.
// `console.log` is forbidden across the codebase by lint.
//
// Sensitive keys are auto-redacted before serialization. Add new keys to
// REDACT_KEYS in the same PR that introduces them.
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
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...redact(ctx),
  });
  process.stderr.write(`${line}\n`);
}

// Sensitive keys redacted automatically. Covers OAuth credentials, bearer
// tokens, PKCE state, and personally-identifying Outreach fields. Adding a
// new sensitive key is part of the PR that introduces it.
const REDACT_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "refresh_token",
  "client_secret",
  "authorization",
  "Authorization",
  "code",
  "code_verifier",
  "state",
  "token",
  "bearer",
  "emails",
  "phoneNumbers",
  "bodyHtml",
  "bodyText",
]);

export function redact<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((entry: unknown) => redact(entry)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.has(key) ? "[REDACTED]" : redact(value);
  }
  return out as T;
}
