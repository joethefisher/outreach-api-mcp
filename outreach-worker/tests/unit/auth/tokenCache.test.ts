import { constants as fsConstants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileTokenCache,
  TokenCachePermissionError,
  type TokenCacheData,
} from "../../../src/auth/tokenCache.js";

let testDir: string;
let cachePath: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(join(tmpdir(), "outreach-mcp-test-"));
  cachePath = join(testDir, "nested", "cache.json");
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const sampleData: TokenCacheData = {
  refreshToken: "rt-abc",
  accessToken: "at-xyz",
  accessTokenExpiresAt: 1_700_000_000_000,
  updatedAt: "2026-05-31T00:00:00.000Z",
};

describe("FileTokenCache.read", () => {
  it("returns null when the file does not exist", async () => {
    const cache = new FileTokenCache(cachePath);
    expect(await cache.read()).toBeNull();
  });

  it("returns null when the file is malformed JSON", async () => {
    await fs.mkdir(join(testDir, "nested"), { recursive: true });
    await fs.writeFile(cachePath, "not-json", "utf8");
    const cache = new FileTokenCache(cachePath);
    expect(await cache.read()).toBeNull();
  });

  it("returns null when the JSON shape is wrong", async () => {
    await fs.mkdir(join(testDir, "nested"), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ foo: "bar" }), "utf8");
    const cache = new FileTokenCache(cachePath);
    expect(await cache.read()).toBeNull();
  });

  it("round-trips a valid record", async () => {
    const cache = new FileTokenCache(cachePath);
    await cache.write(sampleData);
    const out = await cache.read();
    expect(out).toEqual(sampleData);
  });
});

describe("FileTokenCache.write", () => {
  it("creates the parent directory with mode 0o700", async () => {
    const cache = new FileTokenCache(cachePath);
    await cache.write(sampleData);
    const parentStat = await fs.stat(join(testDir, "nested"));
    expect(parentStat.mode & 0o777).toBe(0o700);
  });

  it("writes the file with mode 0o600", async () => {
    const cache = new FileTokenCache(cachePath);
    await cache.write(sampleData);
    const fileStat = await fs.stat(cachePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("overwrites existing data via atomic rename", async () => {
    const cache = new FileTokenCache(cachePath);
    await cache.write(sampleData);
    await cache.write({ ...sampleData, refreshToken: "rt-rotated" });
    const out = await cache.read();
    expect(out?.refreshToken).toBe("rt-rotated");
  });

  it("does not leave a *.tmp file behind on a successful write (SEC-04)", async () => {
    // Indirect proof that the temp file was opened (O_CREAT|O_EXCL) and
    // then atomically renamed onto the final path. If the rename had
    // been skipped or the temp open had returned an existing inode, a
    // `cache.json.<hex>.tmp` would survive in the directory.
    const cache = new FileTokenCache(cachePath);
    await cache.write(sampleData);
    const entries = await fs.readdir(join(testDir, "nested"));
    const stray = entries.filter((e) => e.endsWith(".tmp"));
    expect(stray).toEqual([]);
  });

  it("opens the verify handle with O_NOFOLLOW (Node primitive sanity check) (SEC-04)", async () => {
    // Direct proof that the Node primitives the production code relies
    // on behave as documented on this host: opening a symlink with
    // O_RDONLY|O_NOFOLLOW must fail with ELOOP. If this ever stopped
    // being true, the SEC-04 verify-open invariant would silently relax.
    const target = join(testDir, "target");
    const link = join(testDir, "link");
    await fs.writeFile(target, "x", "utf8");
    await fs.symlink(target, link);
    await expect(fs.open(link, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)).rejects.toThrow();
  });

  it("post-write fstat throws TokenCachePermissionError when mode bits diverge (SEC-03)", async () => {
    // Simulate a filesystem that silently ignores chmod (some overlay /
    // network mounts) by chmoding the file *back* to 0o644 after the
    // production rename but before the verify fstat. Pre-fix this slipped
    // through; post-fix the SEC-03 fstat catches it and throws.
    class PostRenameLoosenedCache extends FileTokenCache {
      override async write(data: TokenCacheData): Promise<void> {
        const originalRename = fs.rename.bind(fs);
        const renamingShim: typeof fs.rename = async (from, to) => {
          await originalRename(from, to);
          // Now that the file is at its final path, loosen it to simulate
          // a filesystem that didn't honor the previous fchmod.
          await fs.chmod(to, 0o644);
        };
        (fs as { rename: typeof renamingShim }).rename = renamingShim;
        try {
          await super.write(data);
        } finally {
          (fs as { rename: typeof originalRename }).rename = originalRename;
        }
      }
    }
    const cache = new PostRenameLoosenedCache(cachePath);
    await expect(cache.write(sampleData)).rejects.toBeInstanceOf(TokenCachePermissionError);
  });

  it("rejects writes that would produce malformed data on round-trip", async () => {
    // Sanity: a record with an empty refresh token is rejected on read,
    // so write/read round-trip degrades to null rather than silently
    // returning a record the runtime can't use.
    await fs.mkdir(join(testDir, "nested"), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ refreshToken: "", updatedAt: "x" }), "utf8");
    const cache = new FileTokenCache(cachePath);
    expect(await cache.read()).toBeNull();
  });
});
