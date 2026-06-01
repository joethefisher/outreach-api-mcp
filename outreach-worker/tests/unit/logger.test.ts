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

describe("redact — value-shape scrubbing (SEC-01)", () => {
  it("scrubs Bearer-shaped tokens inside a value at a benign key", () => {
    const out = redact({ detail: "401 Unauthorized: Bearer abc123.token.xyz==" });
    expect(out.detail).toBe("401 Unauthorized: [REDACTED]");
  });

  it("scrubs form-encoded oauth fields wherever they appear in a string", () => {
    const out = redact({
      upstreamBody: "error=invalid_grant&refresh_token=secret-rt&extra=keep",
    });
    expect(out.upstreamBody).toContain("[REDACTED]");
    expect(out.upstreamBody).not.toContain("secret-rt");
    expect(out.upstreamBody).toContain("extra=keep");
  });

  it("scrubs JWT-shaped values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SIGNATURE-here_123";
    const out = redact({ note: `tried token ${jwt} but it expired` });
    expect(out.note).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out.note).toContain("[REDACTED]");
  });

  it("scrubs tokens echoed via deeply nested input (e.g. noResults envelope)", () => {
    const out = redact({
      errorEnvelope: {
        error: "noResults",
        query: { filters: { token: "Bearer leaked-via-echo" } },
      },
    });
    const envelope = out.errorEnvelope as Record<string, unknown>;
    const query = envelope["query"] as Record<string, unknown>;
    const filters = query["filters"] as Record<string, unknown>;
    expect(filters["token"]).toBe("[REDACTED]");
  });

  it("leaves benign strings alone (no false positives on Outreach data)", () => {
    const out = redact({
      stage: "Discovery",
      sequenceState: "active",
      note: "Following up on the demo we did Tuesday",
    });
    expect(out.stage).toBe("Discovery");
    expect(out.sequenceState).toBe("active");
    expect(out.note).toBe("Following up on the demo we did Tuesday");
  });
});

describe("redact — circular-reference guard (SEC-06)", () => {
  it("does not stack-overflow on a self-referencing object", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj["self"] = obj;
    const out = redact(obj);
    expect(out["name"]).toBe("loop");
    expect(out["self"]).toBe("[Circular]");
  });

  it("does not stack-overflow on a cyclic array", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    const out = redact(arr);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toBe("[Circular]");
  });
});
