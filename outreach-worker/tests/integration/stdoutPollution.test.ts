// SEC-05: stdout-pollution check.
//
// STANDARDS.md §2.1 says "CI test enforces" that the MCP server writes only
// JSON-RPC frames to stdout. Pre-fix no such test existed — the prior
// logger test only asserted that the four `logger.*` methods go to stderr.
// A stray `console.log` in any imported/transitive module, or a third-party
// SDK that writes startup chatter to stdout, would silently corrupt the
// MCP transport with no failing test.
//
// This test spawns the actual server entrypoint as a subprocess and watches
// its stdout. With no MCP client driving it, the spawned process should
// produce ZERO stdout output. Any non-empty stdout content must at least be
// newline-delimited valid JSON (an actual MCP frame, not stray prose).

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(__dirname, "..", "..");
const ENTRYPOINT = resolve(PROJECT_ROOT, "src", "index.ts");

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

function runServer(env: Record<string, string>, durationMs: number): Promise<SpawnResult> {
  return new Promise((resolveFn) => {
    const proc = spawn("npx", ["tsx", ENTRYPOINT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, durationMs);
    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveFn({ stdout, stderr, exitCode });
    });
  });
}

describe("MCP server stdio safety (SEC-05)", () => {
  it("emits nothing on stdout during a misconfigured-startup early exit", async () => {
    // No OAuth env vars → config load throws → fast exit. The startup
    // error goes to stderr (see src/index.ts:427). stdout must remain
    // pristine because the MCP transport hasn't begun.
    const result = await runServer({ OUTREACH_TOKEN_CACHE_PATH: "/dev/null" }, 5000);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0); // startup error logged here
  }, 15000);

  it("any non-empty stdout line must be valid JSON (MCP frame)", async () => {
    // Belt-and-suspenders: even if a future change makes the server
    // print *something* on stdout (e.g. an initial capability frame),
    // every newline-delimited line must parse as JSON. Anything else
    // is a transport-poisoning regression.
    const result = await runServer(
      {
        OUTREACH_CLIENT_ID: "sec05-test",
        OUTREACH_CLIENT_SECRET: "sec05-test",
        OUTREACH_REFRESH_TOKEN: "sec05-test",
        OUTREACH_TOKEN_CACHE_PATH: "/tmp/sec05-stdout-pollution-test.json",
      },
      2000,
    );
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  }, 15000);
});
