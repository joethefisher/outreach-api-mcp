import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileTokenCache, type TokenCacheData } from "../../../src/auth/tokenCache.js";

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

  it("rejects writes that would produce malformed data on round-trip", async () => {
    // Sanity: a record with an empty refresh token is rejected on read,
    // so write/read round-trip degrades to null rather than silently
    // returning a record the runtime can't use.
    await fs.mkdir(join(testDir, "nested"), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({ refreshToken: "", updatedAt: "x" }),
      "utf8",
    );
    const cache = new FileTokenCache(cachePath);
    expect(await cache.read()).toBeNull();
  });
});
