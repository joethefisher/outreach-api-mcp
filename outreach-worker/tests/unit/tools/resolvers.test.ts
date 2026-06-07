import { describe, expect, it } from "vitest";

import {
  resolveAccountByName,
  resolveStageByName,
  resolveUserByName,
} from "../../../src/tools/_resolvers.js";
import { StubOutreachClient } from "../../fixtures/stubOutreachClient.js";

describe("resolveAccountByName", () => {
  it("returns [] for empty / whitespace input without touching the API", async () => {
    const client = new StubOutreachClient({ list: { account: [{ id: 1, name: "Acme" }] } });
    expect(await resolveAccountByName(client, "")).toEqual([]);
    expect(await resolveAccountByName(client, "   ")).toEqual([]);
    expect(client.listCalls).toHaveLength(0);
  });

  it("returns the exact-match page when the name filter hits", async () => {
    const client = new StubOutreachClient({
      list: { account: [{ id: 7, name: "Acme", domain: "acme.com" }] },
    });
    const result = await resolveAccountByName(client, "Acme");
    expect(result).toEqual([{ id: 7, label: "Acme", hint: "acme.com" }]);
    // Only the exact-match call should fire — the broad fallback is skipped.
    expect(client.listCalls).toHaveLength(1);
    expect(client.listCalls[0]?.options?.filters).toMatchObject({ name: "Acme" });
  });

  it("falls back to a substring scan when the exact-match page is empty", async () => {
    // The stub treats the `name: "ACME"` filter as exact equality; "Acme Corp"
    // won't match. The fallback path scans the broad page client-side.
    const client = new StubOutreachClient({
      list: {
        account: [
          { id: 1, name: "Acme Corp" },
          { id: 2, name: "Globex" },
          { id: 3, name: "ACME Holdings", domain: "acme.holdings" },
        ],
      },
    });
    const result = await resolveAccountByName(client, "ACME");
    expect(result.map((m) => m.id)).toEqual([1, 3]);
    expect(result.find((m) => m.id === 3)?.hint).toBe("acme.holdings");
    // First call = exact filter; second call = broad page.
    expect(client.listCalls).toHaveLength(2);
    expect(client.listCalls[0]?.options?.filters).toMatchObject({ name: "ACME" });
    expect(client.listCalls[1]?.options?.filters).toBeUndefined();
  });

  it("returns [] when nothing matches even via fallback", async () => {
    const client = new StubOutreachClient({
      list: { account: [{ id: 1, name: "Globex" }] },
    });
    expect(await resolveAccountByName(client, "Initech")).toEqual([]);
  });

  it("caps results at 20 even when the substring matches more rows", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `Acme${String(i)}`,
    }));
    const client = new StubOutreachClient({ list: { account: rows } });
    // Exact-match on "Acme" won't match any of these — exercises fallback.
    const result = await resolveAccountByName(client, "Acme");
    expect(result).toHaveLength(20);
  });
});

describe("resolveUserByName", () => {
  it("returns [] for empty input without touching the API", async () => {
    const client = new StubOutreachClient({
      list: { user: [{ id: 1, firstName: "Sally", lastName: "Smith" }] },
    });
    expect(await resolveUserByName(client, "")).toEqual([]);
    expect(client.listCalls).toHaveLength(0);
  });

  it("matches by full-name substring (case-insensitive) and includes email hint", async () => {
    const client = new StubOutreachClient({
      list: {
        user: [
          { id: 1, firstName: "Sally", lastName: "Smith", email: "sally@acme.com" },
          { id: 2, firstName: "Sam", lastName: "Jones", email: "sam@acme.com" },
        ],
      },
    });
    const result = await resolveUserByName(client, "SAL");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, label: "Sally Smith", hint: "sally@acme.com" });
  });

  it("matches by email substring too", async () => {
    const client = new StubOutreachClient({
      list: {
        user: [
          { id: 1, firstName: "Sally", lastName: "Smith", email: "sally@acme.com" },
          { id: 2, firstName: "Sam", lastName: "Jones", email: "sam@globex.com" },
        ],
      },
    });
    const result = await resolveUserByName(client, "globex");
    expect(result.map((m) => m.id)).toEqual([2]);
  });

  it("filters out locked users", async () => {
    const client = new StubOutreachClient({
      list: {
        user: [
          { id: 1, firstName: "Sally", lastName: "Smith", email: "sally@x.com", locked: true },
          { id: 2, firstName: "Sally", lastName: "Adams", email: "sally2@x.com" },
        ],
      },
    });
    const result = await resolveUserByName(client, "Sally");
    expect(result.map((m) => m.id)).toEqual([2]);
  });

  it("returns [] when no user matches", async () => {
    const client = new StubOutreachClient({
      list: { user: [{ id: 1, firstName: "Sally", lastName: "Smith" }] },
    });
    expect(await resolveUserByName(client, "nobody")).toEqual([]);
  });

  it("omits the hint field when email is missing or empty", async () => {
    const client = new StubOutreachClient({
      list: {
        user: [
          { id: 1, firstName: "NoEmail", lastName: "User" },
          { id: 2, firstName: "Empty", lastName: "Email", email: "" },
        ],
      },
    });
    const result = await resolveUserByName(client, "user");
    const noEmail = result.find((m) => m.id === 1);
    expect(noEmail?.hint).toBeUndefined();
    expect(noEmail?.label).toBe("NoEmail User");
    const emptyEmail = result.find((m) => m.id === 2);
    expect(emptyEmail?.hint).toBeUndefined();
  });

  it("caps results at 20", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      firstName: "Sam",
      lastName: `Smith${String(i)}`,
      email: `sam${String(i)}@x.com`,
    }));
    const client = new StubOutreachClient({ list: { user: rows } });
    const result = await resolveUserByName(client, "Sam");
    expect(result).toHaveLength(20);
  });
});

describe("resolveStageByName", () => {
  it("returns [] for empty input without touching the API", async () => {
    const client = new StubOutreachClient({
      list: { stage: [{ id: 1, name: "Discovery" }] },
    });
    expect(await resolveStageByName(client, "")).toEqual([]);
    expect(client.listCalls).toHaveLength(0);
  });

  it("matches by substring case-insensitively", async () => {
    const client = new StubOutreachClient({
      list: {
        stage: [
          { id: 1, name: "Discovery" },
          { id: 2, name: "Negotiation" },
          { id: 3, name: "Disqualified" },
        ],
      },
    });
    const result = await resolveStageByName(client, "dis");
    expect(result.map((m) => m.id).sort()).toEqual([1, 3]);
    expect(result[0]?.hint).toBeUndefined(); // stage has no hint field
  });

  it("returns [] when nothing matches", async () => {
    const client = new StubOutreachClient({
      list: { stage: [{ id: 1, name: "Discovery" }] },
    });
    expect(await resolveStageByName(client, "ghost-stage")).toEqual([]);
  });
});
