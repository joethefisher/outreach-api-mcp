import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLogger } from "../../src/logger.js";
import { outreachGetById } from "../../src/tools/outreachGetById.js";
import { outreachQuery } from "../../src/tools/outreachQuery.js";
import {
  cleanupToolContext,
  installToolContext,
  parseEnvelope,
  parseSuccess,
} from "../fixtures/toolHarness.js";

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  configureLogger("info");
  cleanupToolContext();
});

describe("outreachQuery — Tier-2 escape hatch", () => {
  it("rejects a resource outside the allowlist with invalidResource", async () => {
    await installToolContext();
    const raw = await outreachQuery({ resource: "secretAdminThing" });
    const env = parseEnvelope(raw);
    expect(env.error).toBe("invalidResource");
    expect(env["given"]).toBe("secretAdminThing");
  });

  it("rejects malformed filters JSON with validationError", async () => {
    await installToolContext();
    const raw = await outreachQuery({ resource: "prospect", filters: "{not json}" });
    expect(parseEnvelope(raw).error).toBe("validationError");
  });

  it("rejects malformed fields JSON with validationError", async () => {
    await installToolContext();
    const raw = await outreachQuery({ resource: "prospect", fields: "[not valid" });
    expect(parseEnvelope(raw).error).toBe("validationError");
  });

  it("returns normalized rows with profileUrls when the resource is allowed", async () => {
    await installToolContext({
      list: {
        account: [
          { id: 7, name: "Acme", domain: "acme.com" },
          { id: 8, name: "Bcme", domain: "bcme.com" },
        ],
      },
    });
    const raw = await outreachQuery({ resource: "account" });
    const result = parseSuccess(raw) as unknown as {
      resourceType: string;
      results: { id: number; name: string; profileUrl: string }[];
    };
    expect(result.resourceType).toBe("account");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.profileUrl).toBe("https://web.outreach.io/accounts/7");
  });

  it("warns when sort uses a relationship attribute (deprecated)", async () => {
    await installToolContext({ list: { account: [{ id: 1, name: "x" }] } });
    const raw = await outreachQuery({ resource: "account", sort: "owner.firstName" });
    const result = parseSuccess(raw) as unknown as { warnings: string[] };
    expect(result.warnings.some((w) => w.includes("relationship attribute"))).toBe(true);
  });
});

describe("outreachGetById — Tier-2 escape hatch", () => {
  it("rejects a resource outside the allowlist with invalidResource", async () => {
    await installToolContext();
    const raw = await outreachGetById({ resource: "secretThing", id: 1 });
    expect(parseEnvelope(raw).error).toBe("invalidResource");
  });

  it("returns a normalized record with profileUrl on a hit", async () => {
    await installToolContext({
      get: {
        account: {
          7: { id: 7, name: "Acme", domain: "acme.com" },
        },
      },
    });
    const raw = await outreachGetById({ resource: "account", id: 7 });
    const result = parseSuccess(raw) as unknown as { id: number; name: string; profileUrl: string };
    expect(result.id).toBe(7);
    expect(result.profileUrl).toBe("https://web.outreach.io/accounts/7");
  });
});
