# STANDARDS

The bar this codebase commits to. Pull requests and external code reviews grade against this document. If a finding contradicts a standard here, the standard wins or this document gets updated — pick one, don't ignore.

Inspired by Meta's TypeScript guidance and SRE practice. Adapted for an MCP server with OAuth, stdio transport, and a long-lived credential cache.

## 1. TypeScript

1.1. `tsc --strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`. All enabled. No exceptions per-file.

1.2. **No `any`.** Use `unknown` at boundaries (JSON parsing, dynamic dispatch) and narrow with type predicates or zod. Lint blocks `any` as an error.

1.3. **No non-null assertions (`x!`) in production code.** Tests may use them sparingly. In production, narrow first.

1.4. **No `as` casts** except at typed-parse boundaries (e.g. after `JSON.parse(...)`) or interop with third-party libs that under-type their returns. Each cast carries an inline justification.

1.5. **Named exports only.** No `export default`. Default exports break grep, refactor tooling, and import discipline.

1.6. **`readonly` by default.** Function parameters, properties, arrays. Mutate only when necessary and locally.

1.7. **Result-typed boundaries for expected failures.** Throw only for programmer errors and truly exceptional conditions. Expected failures (404, validation, rate limit) return typed error envelopes — see `src/errors/envelopes.ts`.

1.8. **No floating promises.** `no-floating-promises` is an error. Either `await`, `void`, or explicit `.catch`.

1.9. **No `console.*` in production paths.** Use the structured logger. `console.*` is allowed only in `scripts/` (CLI tooling) and tests.

## 2. Security

2.1. **Stdout is sacred.** Stdout carries the MCP JSON-RPC protocol. ANY write to stdout outside MCP frames corrupts the transport. All logging, all diagnostics, all `console.*` use stderr. CI test enforces this with a stdout-pollution check.

2.2. **Tokens never touch logs.** The logger redacts `access_token`, `refresh_token`, `client_secret`, `Authorization`, `code`, `code_verifier`, plus PII fields (`emails`, `phoneNumbers`, `bodyHtml`, `bodyText`). Adding new sensitive keys is part of the PR that adds them.

2.3. **Tokens at rest are `0600`.** Token cache file: owner read/write only. Parent directory: `0700`. Verified by a post-write `fstat` check.

2.4. **OAuth bootstrap uses PKCE S256 + state param.** Both verified on callback. Reject any mismatch.

2.5. **All env-var reads go through `src/config/`.** No scattered `process.env.X` in production code. The config module validates at startup and throws on missing required values with a human-readable message naming the variable.

2.6. **Input validation at the boundary.** Every MCP tool registration has a zod schema. Bodies do not re-validate but may narrow further. The `outreachQuery` escape hatch validates `resource` against an explicit allowlist; deny by default.

2.7. **Read-only invariant.** No `POST`, `PATCH`, `DELETE` issued by any tool. Enforced at the HTTP client layer with a method allowlist.

2.8. **No dynamic code execution.** No `eval`, no `new Function`, no dynamic `require`. Lint blocks.

2.9. **Dependencies pinned.** No `^` or `~` in `package.json`. Updates via Renovate/Dependabot. `npm audit --audit-level=high` runs in CI and fails on findings.

2.10. **No postinstall scripts in transitive deps without review.** When `npm ci` shows a new postinstall, we audit it before merging.

## 3. Architecture

3.1. **One responsibility per module.** If a file does two things, split it.

3.2. **Public interfaces live in `src/<area>/index.ts` re-exports.** Consumers import from the package boundary, not deep paths.

3.3. **Dependency direction:** `tools/` depends on `api/`, `errors/`, `schema/`. `api/` depends on `auth/`, `errors/`, `config/`, `logger`. `auth/` depends on `config/`, `errors/`, `logger`. No cycles (`import/no-cycle` enforced).

3.4. **Side effects only in `src/index.ts` and `scripts/`.** Library modules export functions and classes; they do not run on import.

3.5. **Module-level mutable state is forbidden** except for the explicit singletons (`OutreachClient` factory cache, `OAuthClient` token cache) which expose reset helpers for tests.

## 4. Testing

4.1. **Coverage thresholds (measured layers): lines ≥ 85%, branches ≥ 80%, functions ≥ 85%, statements ≥ 85%.** Enforced by vitest. CI fails on regression. Measured layers = `auth/`, `api/`, `schema/`, `config/`, `errors/`, `logger`. The `tools/` block is excluded from threshold enforcement because its files are composition glue over the well-tested primitives and are exercised by block-level integration tests in `tests/tools/`. v0.2 will tighten this by expanding per-tool tests until the block can be added to the thresholded set.

4.2. **Every public function in the measured layers has at least one test.** Each tool block has at least one integration test against a stub OutreachClient. Each error envelope factory has a unit test.

4.3. **OAuth flow tests use a mock OAuth provider** (in-process HTTP server). The bootstrap script and the refresh-grant runtime are both covered.

4.4. **No live Outreach calls in `npm test`.** Live smoke is a separate script (`npm run smoke:live`) gated by env vars, never run in CI on PRs.

4.5. **Tests are deterministic.** No `Math.random()` or `Date.now()` without injection. Use the test clock helper.

4.6. **One assertion concept per test.** A test fails for one reason. Multi-assert tests are fine when they describe one behavior.

## 5. Style

5.1. **Prettier owns formatting.** Disagreements with Prettier are resolved by editing `.prettierrc.json`, not by overriding per-file.

5.2. **ESLint type-checked rules enabled.** `@typescript-eslint/strict-type-checked` + `stylistic-type-checked` + `import` + `security`.

5.3. **Comments explain WHY, not WHAT.** Code shows what; comments capture the constraint, the surprising decision, the bug worked around, the API quirk. No `// returns the user` over a function literally named `getUser`.

5.4. **JSDoc on exported public surfaces.** Internal helpers don't need it.

## 6. Operations

6.1. **CI must be green to merge.** Required checks: typecheck, lint, format, test (with coverage), build, audit. Node 20 and Node 22 matrix.

6.2. **Build is reproducible.** `npm ci` + `npm run build` from a clean clone produces identical `dist/`.

6.3. **No network calls during build.** `tsc` only. No code generation that hits the internet.

6.4. **Releases follow SemVer.** Breaking tool-schema changes are major bumps. Internal refactors are patch.

## 7. Change discipline

7.1. **Don't add features the task didn't request.** If a port revealed a bug, fix it in a separate commit with a separate justification.

7.2. **Don't add backwards-compatibility shims.** This is v1; we have no installed base. Make the code right and ship.

7.3. **Don't speculate.** Don't add an interface "for future flexibility" unless a current caller needs it.
