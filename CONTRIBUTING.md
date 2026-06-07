# Contributing to outreach-api-mcp

Thanks for the interest. This repo is small enough that the path from "I cloned it" to "I sent a useful PR" should be short.

## Local development

```bash
cd outreach-worker
npm ci                    # reproducible install from package-lock.json
npm run dev               # tsx watch — runs the MCP server in stdio mode
npm test                  # vitest run
npm run test:coverage     # vitest with v8 coverage + threshold enforcement
npm run verify            # the full chain: check + lint + format + test + build
```

`npm run verify` is what CI runs. If it passes locally on Node 20 and Node 22, your PR will pass CI.

## File layout

```
outreach-worker/
  src/
    auth/         OAuth client, token cache, bootstrap helpers, scopes
    api/          HTTP client, JSON:API normalization, filters, pagination, rate limit
    config/       Typed config loader (all process.env access lives here)
    errors/       Discriminated-union error envelopes returned to the agent
    schema/       Outreach /types cache → admin labels for custom fields
    tools/        21 tool implementations + helpers, resolvers, allowlist
    index.ts      MCP server entry point: WorkerCompat shim + tool registrations
    logger.ts     Structured stderr-only JSON logger
  scripts/
    bootstrap-oauth.ts  One-time OAuth consent flow (loopback + PKCE)
  tests/
    fixtures/     Stub OutreachClient + tool harness
    unit/         Per-module unit tests
    tools/        Block-level integration tests against the stub client
```

## Architecture cheat sheet

- **Read-only invariant.** The HTTP client hardcodes `GET` on every request. Tools cannot accidentally `POST`, `PATCH`, or `DELETE` even if a future tool body tried. Only `.read` OAuth scopes are requested. See `STANDARDS.md §2.7` and `src/api/client.ts`.
- **MCP stdio safety.** Stdout is reserved for MCP JSON-RPC frames. All logging goes through `src/logger.ts` to stderr. `console.*` is forbidden in production paths by lint (`STANDARDS.md §2.1`). A test in `tests/unit/logger.test.ts` asserts zero writes to stdout.
- **WorkerCompat shim.** `src/index.ts` defines `WorkerCompat` and `j` shims that mirror `@notionhq/workers` so tool registration call sites look identical to the source repo this was ported from. zod handles `.nullable()`, `.describe()`, `.optional()` natively under the hood.
- **OAuth contention lock.** Concurrent `getAccessToken()` callers coalesce into a single in-flight refresh — see `src/auth/oauth.ts`.
- **401 force-refresh retry.** When Outreach returns 401 mid-stream (token revoked before its TTL), the client invalidates the in-memory cache and retries once with a freshly minted token before surfacing `tokenInvalid`.
- **Tier-2 allowlist.** `outreachQuery` and `outreachGetById` validate the requested resource against `src/tools/allowlist.ts`, denying by default rather than relying on the upstream 403.

## What needs work (good first PRs)

- **Per-tool unit tests.** `tests/tools/` has block-level integration tests for Block A, Block D, and the escape hatches. Blocks B (sequences), C (templates/snippets), and E (drafting) need similar coverage. Once the `tools/` block is well-covered, add it to the threshold-enforced set in `vitest.config.ts`.
- **Sub-account / multi-tenant support.** v0.1 assumes one Outreach workspace per server instance. A multi-tenant configuration would need cache-key segmentation.
- **OAuth scope subsets.** Today the bootstrap requests all 19 read scopes. Letting users request a narrower subset (and having tools surface `scopeMissing` accordingly) would shrink the privilege footprint for read-only-of-one-thing use cases.

## Quality bar

All PRs are graded against [`STANDARDS.md`](./STANDARDS.md). The short version:

- TypeScript strict everywhere — no `any`, no `!`, no floating promises, no `console.*` in src.
- ESLint type-checked + security + import-discipline rules are non-negotiable.
- Tests for new behavior (unit for primitives, integration for tool blocks).
- One module per responsibility; no cross-cutting changes hidden inside a feature PR.
- Don't add features the task doesn't request (`STANDARDS.md §7.1`).
- Don't add backwards-compatibility shims while still pre-1.0 (`STANDARDS.md §7.2`).

## Reporting a vulnerability

Don't open a public issue. Email `joefisherpersonal@gmail.com` and we'll coordinate from there. See [`SECURITY.md`](./SECURITY.md).

## License

Contributions are released under [Apache 2.0](./LICENSE).
