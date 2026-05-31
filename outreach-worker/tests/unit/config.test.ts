import { describe, expect, it } from "vitest";

import { ConfigError, loadBootstrapConfig, loadRuntimeConfig } from "../../src/config/index.js";

const REQUIRED_ENV = {
  OUTREACH_CLIENT_ID: "client-abc",
  OUTREACH_CLIENT_SECRET: "secret-xyz",
} as const;

describe("loadRuntimeConfig", () => {
  it("loads required OAuth credentials and defaults the rest", () => {
    const cfg = loadRuntimeConfig({ ...REQUIRED_ENV });
    expect(cfg.oauth.clientId).toBe("client-abc");
    expect(cfg.oauth.clientSecret).toBe("secret-xyz");
    expect(cfg.apiBase).toBe("https://api.outreach.io/api/v2");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.tokenCachePath).toMatch(/outreach-api-mcp[/\\]token\.json$/);
    expect(cfg.initialRefreshToken).toBeUndefined();
  });

  it("threads the seed refresh token through when present", () => {
    const cfg = loadRuntimeConfig({ ...REQUIRED_ENV, OUTREACH_REFRESH_TOKEN: "rt-1" });
    expect(cfg.initialRefreshToken).toBe("rt-1");
  });

  it("trims whitespace from env values", () => {
    const cfg = loadRuntimeConfig({
      OUTREACH_CLIENT_ID: "  client-abc  ",
      OUTREACH_CLIENT_SECRET: "\tsecret-xyz\n",
    });
    expect(cfg.oauth.clientId).toBe("client-abc");
    expect(cfg.oauth.clientSecret).toBe("secret-xyz");
  });

  it("treats empty strings as unset for optional fields", () => {
    const cfg = loadRuntimeConfig({
      ...REQUIRED_ENV,
      OUTREACH_REFRESH_TOKEN: "   ",
    });
    expect(cfg.initialRefreshToken).toBeUndefined();
  });

  it("honors XDG_CONFIG_HOME for the default cache path", () => {
    const cfg = loadRuntimeConfig({ ...REQUIRED_ENV, XDG_CONFIG_HOME: "/tmp/xdg" });
    expect(cfg.tokenCachePath).toBe("/tmp/xdg/outreach-api-mcp/token.json");
  });

  it("honors OUTREACH_TOKEN_CACHE_PATH override", () => {
    const cfg = loadRuntimeConfig({
      ...REQUIRED_ENV,
      OUTREACH_TOKEN_CACHE_PATH: "/var/secrets/outreach.json",
    });
    expect(cfg.tokenCachePath).toBe("/var/secrets/outreach.json");
  });

  it("normalizes a trailing slash on OUTREACH_API_BASE", () => {
    const cfg = loadRuntimeConfig({
      ...REQUIRED_ENV,
      OUTREACH_API_BASE: "https://api.example.com/v2/",
    });
    expect(cfg.apiBase).toBe("https://api.example.com/v2");
  });

  it("rejects a missing client id with a named ConfigError", () => {
    expect(() => loadRuntimeConfig({ OUTREACH_CLIENT_SECRET: "x" })).toThrow(ConfigError);
    expect(() => loadRuntimeConfig({ OUTREACH_CLIENT_SECRET: "x" })).toThrow(/OUTREACH_CLIENT_ID/);
  });

  it("rejects a non-https api base", () => {
    expect(() =>
      loadRuntimeConfig({ ...REQUIRED_ENV, OUTREACH_API_BASE: "http://api.outreach.io/api/v2" }),
    ).toThrow(/https/);
  });

  it("rejects an unknown log level", () => {
    expect(() => loadRuntimeConfig({ ...REQUIRED_ENV, LOG_LEVEL: "TRACE" })).toThrow(/LOG_LEVEL/);
  });
});

describe("loadBootstrapConfig", () => {
  it("loads OAuth credentials and defaults the redirect port to 8765", () => {
    const cfg = loadBootstrapConfig({ ...REQUIRED_ENV });
    expect(cfg.redirectPort).toBe(8765);
  });

  it("accepts a valid redirect port override", () => {
    const cfg = loadBootstrapConfig({
      ...REQUIRED_ENV,
      OUTREACH_OAUTH_REDIRECT_PORT: "9000",
    });
    expect(cfg.redirectPort).toBe(9000);
  });

  it("rejects a non-integer redirect port", () => {
    expect(() =>
      loadBootstrapConfig({ ...REQUIRED_ENV, OUTREACH_OAUTH_REDIRECT_PORT: "9.5" }),
    ).toThrow(/OUTREACH_OAUTH_REDIRECT_PORT/);
  });

  it("rejects a redirect port outside 1-65535", () => {
    expect(() =>
      loadBootstrapConfig({ ...REQUIRED_ENV, OUTREACH_OAUTH_REDIRECT_PORT: "70000" }),
    ).toThrow(/OUTREACH_OAUTH_REDIRECT_PORT/);
    expect(() =>
      loadBootstrapConfig({ ...REQUIRED_ENV, OUTREACH_OAUTH_REDIRECT_PORT: "0" }),
    ).toThrow(/OUTREACH_OAUTH_REDIRECT_PORT/);
  });
});
