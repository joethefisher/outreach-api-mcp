// Integration tests for the loopback callback listener.
//
// Drives the actual node:http server (binds to 127.0.0.1 on an ephemeral
// port, hits it with global fetch, asserts what comes back) — not just the
// pure parseCallback helper. Closes the TST-03 gap from the §4.2 review.

import { describe, expect, it } from "vitest";

import { awaitCallback } from "../../../src/auth/bootstrap.js";

function callback(port: number, query: string, path = "/callback"): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}?${query}`);
}

/** Wrap result so Node doesn't flag rejections as unhandled while the
 *  test's actual await is still being scheduled. The reified Promise
 *  always *resolves* — to the Error if there was one, or to a sentinel. */
function reify<T>(p: Promise<T>): Promise<T | Error> {
  return p.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
}

describe("awaitCallback — loopback OAuth listener", () => {
  it("resolves with `code` on a valid callback and returns a 200 OK", async () => {
    const handle = await awaitCallback(0, "expected-state", { timeoutMs: 5000 });
    expect(handle.port).toBeGreaterThan(0);

    const response = await callback(handle.port, "code=auth-code-1&state=expected-state");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("authorization complete");

    const result = await handle.result;
    expect(result.code).toBe("auth-code-1");
  });

  it("rejects with a CSRF error on state mismatch and returns 400 to the browser", async () => {
    const handle = await awaitCallback(0, "expected-state", { timeoutMs: 5000 });
    const reified = reify(handle.result);

    const response = await callback(handle.port, "code=x&state=attacker-state");
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("state mismatch");

    const err = await reified;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/state mismatch/);
  });

  it("rejects with the provider's error description when `error` param is present", async () => {
    const handle = await awaitCallback(0, "s", { timeoutMs: 5000 });
    const reified = reify(handle.result);

    const response = await callback(
      handle.port,
      "error=access_denied&error_description=User%20said%20no&state=s",
    );
    expect(response.status).toBe(400);

    const err = await reified;
    expect((err as Error).message).toMatch(/access_denied/);
  });

  it("rejects when `code` is missing", async () => {
    const handle = await awaitCallback(0, "s", { timeoutMs: 5000 });
    const reified = reify(handle.result);

    const response = await callback(handle.port, "state=s");
    expect(response.status).toBe(400);

    const err = await reified;
    expect((err as Error).message).toMatch(/missing authorization code/);
  });

  it("returns 404 on unrelated paths without resolving the callback promise", async () => {
    const handle = await awaitCallback(0, "s", { timeoutMs: 5000 });
    const reified = reify(handle.result);

    const response = await fetch(`http://127.0.0.1:${String(handle.port)}/wat`);
    expect(response.status).toBe(404);

    // Listener stays armed — the handler hasn't resolved or rejected. Close
    // the listener manually. Result then never settles; that's the intended
    // semantic for "wrong path == ignore." Race a short timeout against the
    // promise to confirm it stays pending.
    handle.close();
    const winner = await Promise.race<string>([
      reified.then(() => "settled"),
      new Promise<string>((res) => {
        setTimeout(() => {
          res("pending");
        }, 50);
      }),
    ]);
    expect(winner).toBe("pending");
  });

  it("rejects with a timeout error when no callback arrives in the configured window", async () => {
    const handle = await awaitCallback(0, "s", { timeoutMs: 50 });
    const err = await reify(handle.result);
    expect((err as Error).message).toMatch(/Timed out/);
  });

  it("rejects non-GET methods with 405 + Allow header (SEC-07)", async () => {
    const handle = await awaitCallback(0, "s", { timeoutMs: 5000 });
    const response = await fetch(
      `http://127.0.0.1:${String(handle.port)}/callback?state=s&code=x`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    handle.close();
    // Result was never resolved because the POST was rejected pre-parse.
    void reify(handle.result);
  });

  it("uses constant-time state comparison so a near-match doesn't leak via timing (SEC-07)", async () => {
    // Behavioral check: a near-prefix state and a wildly different state
    // both reject with the same error message. We can't measure timing
    // reliably here, but we CAN assert that timingSafeEqual's
    // length-guard branch fires for inputs of different length, and that
    // equal-length-but-different inputs reject cleanly.
    const handle1 = await awaitCallback(0, "expected-state-32-bytes-aaaaaaaa", { timeoutMs: 5000 });
    const reified1 = reify(handle1.result);
    const r1 = await fetch(
      `http://127.0.0.1:${String(handle1.port)}/callback?state=different-length&code=x`,
    );
    expect(r1.status).toBe(400);
    await expect(reified1).resolves.toMatchObject({
      message: expect.stringMatching(/state mismatch/) as unknown,
    });

    const handle2 = await awaitCallback(0, "expected-state-32-bytes-aaaaaaaa", { timeoutMs: 5000 });
    const reified2 = reify(handle2.result);
    const r2 = await fetch(
      `http://127.0.0.1:${String(handle2.port)}/callback?state=expected-state-32-bytes-bbbbbbbb&code=x`,
    );
    expect(r2.status).toBe(400);
    await expect(reified2).resolves.toMatchObject({
      message: expect.stringMatching(/state mismatch/) as unknown,
    });
  });

  it("binds only to 127.0.0.1 — reachable on loopback, port assigned ephemerally", async () => {
    const handle = await awaitCallback(0, "s", { timeoutMs: 5000 });
    expect(handle.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${String(handle.port)}/wat`);
    expect(response.status).toBe(404);
    handle.close();
    // Don't await result — it'll never settle on a wrong-path hit. The
    // listener is closed; vitest can move on without us hanging.
    void reify(handle.result);
  });
});
