// Typed configuration loader.
//
// All `process.env` access in production code MUST go through here (see
// STANDARDS.md §2.5). Two views: `loadRuntimeConfig()` for the MCP server,
// `loadBootstrapConfig()` for the one-time OAuth bootstrap script.
//
// Validates at load time and throws `ConfigError` with a human-readable
// message that names the offending variable. Never logs (the logger has its
// own init path; this module cannot depend on it without creating a cycle).

import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const DEFAULT_API_BASE = "https://api.outreach.io/api/v2";
const DEFAULT_REDIRECT_PORT = 8765;
const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface OAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface RuntimeConfig {
  readonly oauth: OAuthCredentials;
  /** Seed refresh token from env. The auth layer prefers the on-disk cache. */
  readonly initialRefreshToken?: string;
  readonly apiBase: string;
  readonly tokenCachePath: string;
  readonly logLevel: LogLevel;
}

export interface BootstrapConfig {
  readonly oauth: OAuthCredentials;
  readonly redirectPort: number;
  readonly tokenCachePath: string;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const seedToken = readOptional(env, "OUTREACH_REFRESH_TOKEN");
  return {
    oauth: {
      clientId: readRequired(env, "OUTREACH_CLIENT_ID"),
      clientSecret: readRequired(env, "OUTREACH_CLIENT_SECRET"),
    },
    ...(seedToken === undefined ? {} : { initialRefreshToken: seedToken }),
    apiBase: readApiBase(env),
    tokenCachePath: readTokenCachePath(env),
    logLevel: readLogLevel(env),
  };
}

export function loadBootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  return {
    oauth: {
      clientId: readRequired(env, "OUTREACH_CLIENT_ID"),
      clientSecret: readRequired(env, "OUTREACH_CLIENT_SECRET"),
    },
    redirectPort: readRedirectPort(env),
    tokenCachePath: readTokenCachePath(env),
    logLevel: readLogLevel(env),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function readRequired(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigError(
      `Required environment variable ${key} is not set. See .env.example for details.`,
    );
  }
  return value;
}

function readOptional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readApiBase(env: NodeJS.ProcessEnv): string {
  const raw = readOptional(env, "OUTREACH_API_BASE") ?? DEFAULT_API_BASE;
  if (!raw.startsWith("https://")) {
    throw new ConfigError(`OUTREACH_API_BASE must be an https URL. Got: ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

function readRedirectPort(env: NodeJS.ProcessEnv): number {
  const raw = readOptional(env, "OUTREACH_OAUTH_REDIRECT_PORT");
  if (raw === undefined) return DEFAULT_REDIRECT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`OUTREACH_OAUTH_REDIRECT_PORT must be an integer 1-65535. Got: ${raw}`);
  }
  return n;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readOptional(env, "LOG_LEVEL")?.toLowerCase();
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  if (!isLogLevel(raw)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}. Got: ${raw}`);
  }
  return raw;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function readTokenCachePath(env: NodeJS.ProcessEnv): string {
  const override = readOptional(env, "OUTREACH_TOKEN_CACHE_PATH");
  if (override !== undefined) return override;
  const xdgConfig = readOptional(env, "XDG_CONFIG_HOME") ?? join(homedir(), ".config");
  return join(xdgConfig, "outreach-api-mcp", "token.json");
}
