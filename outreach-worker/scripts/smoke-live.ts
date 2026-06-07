#!/usr/bin/env node
// Live smoke test: prove the configured OAuth credentials can talk to
// the real Outreach API end-to-end.
//
// Run via:  npm run smoke:live
//
// Reads OUTREACH_CLIENT_ID / OUTREACH_CLIENT_SECRET / OUTREACH_REFRESH_TOKEN
// from `../.env` (or the existing env). On success, prints how many users the
// configured workspace returned + exits 0. On failure, prints the error to
// stderr and exits 1.
//
// Intentionally minimal — this is a "is the build alive" smoke test, not a
// regression suite. The unit + integration tests in `tests/` cover correctness.
// Output goes to stderr so the script is safe to compose into other tools that
// reserve stdout for structured output.

import { getOutreachClient } from "../src/api/client.js";
import { loadRuntimeConfig } from "../src/config/index.js";
import { configureLogger } from "../src/logger.js";

async function main(): Promise<void> {
  const cfg = loadRuntimeConfig();
  configureLogger(cfg.logLevel);

  process.stderr.write("→ outreach-api-mcp live smoke test\n");
  process.stderr.write(`→ Client ID: ${cfg.oauth.clientId.slice(0, 8)}…\n`);
  process.stderr.write("→ Calling listUsers() to confirm the token is healthy…\n");

  const users = await getOutreachClient().listUsers();

  process.stderr.write(`✓ OK — ${String(users.length)} user(s) returned.\n`);
  process.stderr.write("  This proves OAuth refresh + scope grant + network path all work.\n");
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`✗ Smoke test failed: ${message}\n`);
  process.exit(1);
});
