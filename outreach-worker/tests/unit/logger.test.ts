import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureLogger, logger, redact } from "../../src/logger.js";

interface CapturedStreams {
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureStreams(): CapturedStreams {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return { stdout, stderr };
}

describe("logger output channel — MCP stdio safety", () => {
  beforeEach(() => {
    configureLogger("debug");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configureLogger("info");
  });

  it("never writes to stdout (stdout is reserved for MCP frames)", () => {
    const streams = captureStreams();
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.length).toBe(4);
  });

  it("emits structured JSON with ts/level/msg fields", () => {
    const streams = captureStreams();
    logger.info("hello", { requestId: "req-1" });
    expect(streams.stderr.length).toBe(1);
    const line = streams.stderr[0]!;
    expect(line.endsWith("\n")).toBe(true);
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toMatchObject({ level: "info", msg: "hello", requestId: "req-1" });
    expect((parsed as { ts: string }).ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("suppresses messages below the configured level", () => {
    configureLogger("warn");
    const streams = captureStreams();
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    logger.error("yes");
    expect(streams.stderr.length).toBe(2);
  });
});

describe("redact", () => {
  it("replaces values at sensitive keys", () => {
    const out = redact({
      access_token: "secret",
      refresh_token: "secret",
      client_secret: "secret",
      Authorization: "Bearer secret",
      code: "abc",
      code_verifier: "v",
      state: "s",
      token: "t",
      bearer: "b",
      emails: ["a@b.c"],
      phoneNumbers: ["555"],
      bodyHtml: "<p>x</p>",
      bodyText: "x",
      keep: "visible",
    });
    expect(out.keep).toBe("visible");
    for (const key of [
      "access_token",
      "refresh_token",
      "client_secret",
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
    ] as const) {
      expect((out as Record<string, unknown>)[key]).toBe("[REDACTED]");
    }
  });

  it("recurses into nested objects and arrays", () => {
    const out = redact({
      outer: {
        access_token: "x",
        inner: { refresh_token: "y", keep: 1 },
      },
      list: [{ code: "1", keep: "ok" }],
    });
    expect(out.outer.access_token).toBe("[REDACTED]");
    expect(out.outer.inner.refresh_token).toBe("[REDACTED]");
    expect(out.outer.inner.keep).toBe(1);
    expect(out.list[0]!.code).toBe("[REDACTED]");
    expect(out.list[0]!.keep).toBe("ok");
  });

  it("returns primitives, null, and undefined unchanged", () => {
    expect(redact(null)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- redact<undefined> inference quirk; intent is to assert undefined passthrough
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact("hi")).toBe("hi");
    expect(redact(true)).toBe(true);
  });
});
