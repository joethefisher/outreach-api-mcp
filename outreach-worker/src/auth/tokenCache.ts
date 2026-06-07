// On-disk cache for the OAuth refresh + access tokens.
//
// Security properties (see SECURITY.md):
//   - Parent directory created with mode 0o700 (owner only).
//   - Cache file written with mode 0o600 (owner read/write only).
//   - Writes are atomic: temp file in the same directory, fsync, rename.
//   - SEC-03: post-write fstat — re-open the cache file after rename and
//     verify (mode & 0o777) === 0o600. Throw `TokenCachePermissionError`
//     on mismatch. This is the documented §2.3 control; without it a
//     filesystem that silently ignores mode bits would let a long-lived
//     refresh token land world-readable and the write would still
//     "succeed."
//   - Malformed JSON returns null (the caller falls back to env seed or
//     surfaces OAuthNotInitialized — never crash on corruption).
//
// The cache is the source of truth at runtime. The env `OUTREACH_REFRESH_TOKEN`
// is only consulted as a seed when the cache is empty (first run).

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { logger } from "../logger.js";

export interface TokenCacheData {
  readonly refreshToken: string;
  /** Latest access token. Optional because the cache may exist with refresh-only on first seed. */
  readonly accessToken?: string;
  /** Epoch ms when the access token expires. Meaningful only when accessToken is present. */
  readonly accessTokenExpiresAt?: number;
  /** ISO timestamp of the most recent write. Observability aid. */
  readonly updatedAt: string;
}

export interface TokenCache {
  read(): Promise<TokenCacheData | null>;
  write(data: TokenCacheData): Promise<void>;
}

/** SEC-03: thrown when a post-write fstat sees mode bits other than 0o600. */
export class TokenCachePermissionError extends Error {
  constructor(
    public readonly path: string,
    public readonly mode: number,
  ) {
    super(
      `Token cache at ${path} has mode 0o${(mode & 0o777).toString(8).padStart(3, "0")} after write; expected 0o600. Refusing to leave credentials at unsafe permissions.`,
    );
    this.name = "TokenCachePermissionError";
  }
}

export class FileTokenCache implements TokenCache {
  constructor(private readonly path: string) {}

  async read(): Promise<TokenCacheData | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch (e) {
      if (isNodeErrnoException(e) && e.code === "ENOENT") return null;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn("tokenCache.read.malformedJson", { path: this.path });
      return null;
    }
    if (!isTokenCacheData(parsed)) {
      logger.warn("tokenCache.read.malformedShape", { path: this.path });
      return null;
    }
    return parsed;
  }

  async write(data: TokenCacheData): Promise<void> {
    const dir = dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir with mode applies only on creation. Defensively re-chmod the
    // leaf parent directory in case it already existed with looser perms.
    try {
      await fs.chmod(dir, 0o700);
    } catch (e) {
      // chmod can fail (EPERM) when the directory is shared (e.g. ~/.config
      // owned by root in some container setups). The token file itself will
      // still be 0600 — log and continue.
      logger.warn("tokenCache.parentChmodFailed", {
        dir,
        err: e instanceof Error ? e.message : String(e),
      });
    }

    const tmp = `${this.path}.${String(process.pid)}.tmp`;
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // rename is atomic on POSIX. On macOS/Linux it preserves the source's
    // mode (0o600). Defensively chmod after rename in case of overlay FS quirks.
    await fs.rename(tmp, this.path);
    await fs.chmod(this.path, 0o600);

    // SEC-03: re-open and fstat to verify the final on-disk mode bits.
    // chmod() can be silently ignored by certain filesystems (NTFS via
    // some bridges, some overlay FS layers, network mounts). Without
    // this check the documented §2.3 "0600 verified" claim is false and
    // a long-lived refresh token can land world-readable.
    const verifyHandle = await fs.open(this.path, "r");
    try {
      const stat = await verifyHandle.stat();
      if ((stat.mode & 0o777) !== 0o600) {
        throw new TokenCachePermissionError(this.path, stat.mode);
      }
    } finally {
      await verifyHandle.close();
    }
  }
}

function isTokenCacheData(value: unknown): value is TokenCacheData {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["refreshToken"] !== "string" || v["refreshToken"].length === 0) return false;
  if (typeof v["updatedAt"] !== "string" || v["updatedAt"].length === 0) return false;
  if (v["accessToken"] !== undefined && typeof v["accessToken"] !== "string") return false;
  if (v["accessTokenExpiresAt"] !== undefined && typeof v["accessTokenExpiresAt"] !== "number") {
    return false;
  }
  return true;
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
