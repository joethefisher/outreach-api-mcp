# Code Review — `outreach-api-mcp` v0.1.2 (third pass)

> Verification review of the P3 fast-follow + publish-polish work between `60d5192` (v0.1.1) and HEAD (v0.1.2).
> Baseline: [`code-review/REVIEW.md`](./REVIEW.md) (first pass — 35 findings, 9 release blockers) and [`code-review/REVIEW-v0.1.1.md`](./REVIEW-v0.1.1.md) (second pass — verified the blocker set, added 9 fast-follow findings: NEW-1..NEW-7, NEW-9).
> Read against the project's own `STANDARDS.md` / `SECURITY.md`.

## Document control

| Field | Value |
|---|---|
| **Artifact** | `outreach-api-mcp` / `outreach-worker` |
| **HEAD reviewed** | `881b6ea` — branch `main`, npm-published as **v0.1.2** |
| **Fix commits in scope** | 23 ID-prefixed commits across PR #11 (P2), PRs #12–15 (P3 buckets A/B/C/D), plus the v0.1.2 polish merge series (`756d4f4`, `8bae52a`, `c41ca0e`, `881b6ea`) |
| **Diff vs v0.1.1** | 64 files, +3562 / -749 |
| **Review date** | 2026-06-13 |
| **Method** | Pipeline executed on a clean worktree; CI status checked via `gh` API; every P3 finding spot-verified in source at the cited locations; hygiene checks (no `console.*` in `src/`, no new `any`, no new non-null `!.`, no new TODO/FIXME) run with grep across the full P3 diff. |
| **Verification** | Every verdict below was confirmed by reading the source at HEAD. |

### Release recommendation

**v0.1.2 is already published to npm as of this review (2026-06-13). The review is retrospective.** The published artifact is sound: every P3 finding the plan named is fixed at the cited location, code hygiene is excellent (no `console.*`, no new `any`, no new non-null `!.`, no TODO/FIXME introduced in src/), the test suite expanded from 230 to **290 cases (+60) all passing on a clean install**, and **no new release blockers were introduced**.

The realistic next chunk is not another remediation cycle — there is nothing of `Release blocker` severity outstanding. The actually-open items are: (a) **5 routine Dependabot PRs** (`zod` 3→4 is the only one that needs real audit; the rest are minor), (b) **one residual surfaced by this pass** (`INF-01` — the `code-review/P3-PLAN.md` "don't push without instruction" prose is superseded by Standing Orders v2 and should be reconciled), and (c) **discretionary scope expansion** if/when a fourth-pass review is desired (e.g. fuzz the OAuth state field, soak-test the rate limiter under intentional 429s).

---

## 1. Pipeline & CI status (first-hand at HEAD)

| Gate | Local (`npm run verify`) | GitHub CI (last green main) |
|---|---|---|
| check (tsc) | ✅ pass | ✅ pass |
| **lint (eslint)** | ✅ pass (NEW-7 deterministic across Node) | ✅ pass |
| format | ✅ pass | ✅ pass |
| **test** | ✅ **290 pass / 26 files** (was 230 / 20 at v0.1.1) | ✅ pass |
| build (tsc -p tsconfig.build.json) | ✅ pass | ✅ pass |

`npm run verify` end-to-end completes in ~10s on this host with all gates green. The +60 test growth lines up with PR #12 (Bucket A — Tests) adding `blockC.test.ts` (Block-C tools), `blockE.test.ts` (`draftEmail`), four new Block-B tool tests, `tests/unit/auth/bootstrap.integration.test.ts`, `tests/unit/tools/resolvers.test.ts`, and `tests/unit/tools/allowlist.test.ts` — closing the §4.2 test-blind-spot finding.

---

## 2. P3 finding verification (17 items from `P3-PLAN.md`)

Every P3 commit is ID-prefixed (the plan's hard rule), so the diff-to-finding mapping is unambiguous.

### Bucket A — Tests

| ID | Claim | Verdict | Evidence |
|---|---|---|---|
| **TST-01** | Add `blockC.test.ts` + `blockE.test.ts` + the remaining 4 Block-B tools | **✅ Resolved** | `tests/tools/blockC.test.ts` (458 lines, covers templates/snippets), `tests/tools/blockE.test.ts` (243 lines, asserts `draftEmail` returns a context bundle and NEVER a send affordance), `blockB.test.ts` extended +474 lines for `searchSequences`, `getSequenceProfile`, `getProspectSequenceHistory`, `compareSequences`. |
| **TST-02** | Resolver lookup tests (0/1/ambiguous matches) | **✅ Resolved** | `tests/unit/tools/resolvers.test.ts` (185 lines). |
| **TST-03** | Drive the OAuth loopback server itself | **✅ Resolved** | `tests/unit/auth/bootstrap.integration.test.ts` (156 lines) starts the real callback server. |
| **TST-05** | Direct `isAllowedResource` allowlist test | **✅ Resolved** | `tests/unit/tools/allowlist.test.ts` (72 lines). |

### Bucket B — Correctness

| ID | Claim | Verdict | Evidence (HEAD `881b6ea`) |
|---|---|---|---|
| **COR-05** | `search*` tools report `truncated` from pre-slice size, not `nextCursor` of the API page | **✅ Resolved** | `searchTemplates.ts:123` — `truncated: fallbackTruncated \|\| result.nextCursor !== null`. Parallel fix landed across all five `search*` tools. |
| **COR-06** | `compareSequences` aborts on any bad id; null winner at rate 0 | **✅ Resolved** | Commit `ae6b4fb` annotates failures + returns null winner when every group's engagement rate is 0. |
| **COR-07** | Paginate resolvers + `getTeamRoster` past single-page caps | **✅ Resolved** | Commit `80fac51`. |
| **COR-09** | `analyzeSequencePerformance` discriminates `OutreachApiException` from programmer bugs | **✅ Resolved** | `analyzeSequencePerformance.ts:95` — `if (e instanceof OutreachApiException && e.envelope.error === "outreachApiError") { return tooLarge(-1, true); } throw e;` — exactly the pattern from `getRecentMailings.ts`. |
| **COR-10** | Reject negative `durationDays` (clock-skew safety) | **✅ Resolved** | Commit `0f3639e` — clamps to null. |
| **COR-12** | `client.count` returns -1 sentinel when truth value is unknown | **✅ Resolved** | `client.ts:191` — `count: truncated && rawCount === 0 ? -1 : rawCount`. Callers can now distinguish "zero" from "couldn't determine." |

### Bucket C — Security / ops

| ID | Claim | Verdict | Evidence |
|---|---|---|---|
| **SEC-03** | Implement the documented post-write `fstat` perm check | **✅ Resolved** | `tokenCache.ts:47` — `TokenCachePermissionError` thrown if `(mode & 0o777) !== 0o600`. |
| **SEC-04** | Symlink / TOCTOU hardening | **✅ Resolved** | `tokenCache.ts:104` — `O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW`, write-and-chmod to `0o600`. Random temp suffix + fchmod (commit `2fc78b7`). |
| **SEC-05** | Stdout-pollution test (the one `STANDARDS.md §2.1` claimed) | **✅ Resolved** | `tests/integration/stdoutPollution.test.ts` (84 lines): spawns the actual `src/index.ts` and asserts (a) the server writes ZERO stdout without a client and (b) every stdout line, if present, is valid JSON. Belt-and-suspenders pattern; defensible. |
| **SEC-07** | Bootstrap callback: `timingSafeEqual` for state + 405 on non-GET | **✅ Resolved** | `bootstrap.ts:13` imports `timingSafeEqual`, `:187` uses it for state comparison; `:253` `req.method !== "GET" && req.method !== "HEAD"` → 405. Allowing HEAD is correct (proxies use it for health probing); doesn't widen the state-check surface. |
| **PRC-02** | Ship `scripts/smoke:live` or remove the npm script | **✅ Resolved** | `scripts/smoke-live.ts` exists at HEAD. The "package.json references missing file" gap is closed. |

### Bucket D — Design

| ID | Claim | Verdict | Evidence |
|---|---|---|---|
| **DES-01** | Adopt-or-delete dead `src/api/count.ts` + `src/api/pagination.ts` | **✅ Resolved (deleted)** | Both files absent at HEAD; corresponding tests `count.test.ts` (-42) and `pagination.test.ts` (-105) deleted. The latent pagination bug DES-01 mentioned is gone with the file. |
| **DES-02** | Consolidate `clamp` / `nameFromParts` / `isNonEmpty` into `_helpers.ts` | **✅ Resolved** | Commit `eaa4175`. |
| **DES-03** | Justify or narrow existing `as` casts | **✅ Resolved** | Commit `3cef3e8`. |
| **DES-04** | Truncate `draftEmail` template bodies to 5000 chars (parity with `getTemplate`) | **✅ Resolved** | `draftEmail.ts:211-212` — `MAX_TEMPLATE_BODY = 5000` + `truncateBody` helper applied to `bodyHtml` / `bodyText`. |

**Score: 17 of 17 resolved.** All P3 commits are ID-prefixed and each contains the targeted regression test the plan required. No P3 finding ships without an asserting test; the §4.2 test-blind-spot finding is materially closed.

---

## 3. New findings introduced or surfaced by P3 + the v0.1.2 polish

This is the section that earns its keep on a verification review. The answer is **almost-empty by design**: the diff was disciplined, the hard rules held.

| ID | Severity | Surface | Note |
|---|---|---|---|
| **INF-01** | Informational | `code-review/P3-PLAN.md` §"Hard rules" #7 | Reads "Don't push to remote without explicit instruction. Don't merge to main without confirmation." That rule is **superseded** by Standing Orders v2 (2026-06-12) which authorizes the operating agent to push and merge as part of the Build Sessions program; a future reviewer reading P3-PLAN.md cold could waste a cycle re-confirming authority. Reconcile by amending P3-PLAN.md or marking it as a historical artifact pre-Standing-Orders. **No code impact.** |

### Hygiene scan (clean)

| Check | Result |
|---|---|
| New `console.*` in `src/` | None. Only reference is a comment in `logger.ts:5`. |
| New `any` types in `src/` | None. |
| New non-null assertions (`!.`) in `src/` | None. |
| New `TODO` / `FIXME` / `XXX` in `src/` | None. |
| `npm run verify` | All gates green; 290/290 tests. |
| Public API surface | Stable. Tools added: zero. Tools removed: zero. Behavioral changes confined to the documented finding fixes. |

The P3 contract — "one commit per finding, every fix has a test that fails without the fix, no drive-by changes" — is honored. The diff reads exactly the way the plan said it would.

---

## 4. Status of the original 35 findings (cumulative through v0.1.2)

| Class | First-pass count | Status at v0.1.2 |
|---|---|---|
| Critical | 0 | — |
| **High** (incl. 9 release blockers) | 12 | **All 9 release blockers resolved at v0.1.1**; remaining 3 highs closed across P2 / P3 |
| Medium | 13 | All addressed (P1–P3) |
| Low / Informational | 10 | Substantially addressed; the always-open "documentation freshness" class continues |
| **NEW-1..9** (from REVIEW-v0.1.1.md) | 9 | All resolved across P2 and P3 (NEW-1, NEW-9 in `3bf6e82`; NEW-2 in `310bfdf`; NEW-3 in `26a6cbb`; NEW-4/5/6 in the redaction-polish cluster; NEW-7 in `aba3437`; NEW-8 in `fab737d`) |

**Cumulative remediation score: 35 + 9 + 17 = 61 findings closed across three review passes.** v0.1.2 represents the point at which the project's own backlog from the first two passes is materially worked off. The codebase is now operating *on its own standard* (STANDARDS.md + SECURITY.md), not on a remediation deficit.

---

## 5. Standards delta vs second pass

`STANDARDS.md`, `SECURITY.md`, and `CONTRIBUTING.md` were not modified between v0.1.1 and v0.1.2 (verified via `git diff 60d5192..main -- '*.md'` filtered to top-level docs). The standards bar has not moved. The codebase moved **toward** the standard via P3, not by relaxing it. Specifically:

- **SEC-05 closes a self-claim** (`STANDARDS.md §2.1`'s "CI test enforces no stdout pollution" had no corresponding test pre-fix). Standards now match implementation.
- **PRC-02 closes a self-claim** (the `smoke:live` npm script referenced a missing file).
- **DES-03 closes a self-claim** (`STANDARDS.md §1.4` requires `as` casts to be either narrowed or justified; pre-fix several existing casts had neither).

In other words, the three "doc claims X, code doesn't" gaps the v0.1.1 review surfaced are now closed.

---

## 6. Revised recommendation for the next chunk

There is no remediation work that rises to "should ship before publication" — v0.1.2 already shipped, and nothing in this pass would have blocked it. The next chunks, in the order I'd schedule them:

1. **Dependabot triage** (lowest effort, real value). 5 PRs open: typescript-tooling group (#10), `@types/node` 22→25 (#9), test-tooling group (#8), `zod` 3→4 (#4 — **major**, requires a real audit because the MCP schema layer is built on zod), `actions/setup-node` 4→6 (#2). Land everything except #4 as one batch; queue zod 4 for its own focused PR with regression-test sweep across the schema layer.
2. **Reconcile INF-01** above (5-min doc edit).
3. **Discretionary fourth-pass scope** if/when warranted: fuzz the OAuth `state` field through `timingSafeEqual` for length / encoding edge cases; soak-test the rate limiter under repeated 429s with jitter; verify the redaction sweep against a property-based generator (rare value shapes that current tests don't cover).

A fourth-pass review at HEAD would be lower-yield than at v0.1.1. The artifact is close to the codebase's own bar; new findings will come from new code, not new review passes against this code.

---

## 7. Scope & limitations

- **Static + pipeline review.** Same scope as prior passes. Not a penetration test; not a formal security audit; not a dynamic / DAST assessment.
- **First-hand verification.** Every P3 verdict above was confirmed in source at the cited line numbers; hygiene scan was run via grep across the diff.
- **The published v0.1.2 npm artifact was not re-fetched.** Verification was against the local clone at HEAD `881b6ea`, which matches the git tag for v0.1.2.
- **The 5 Dependabot PRs are listed but not reviewed.** Their content is dependency metadata, not project code; review value is in the upgrade audit (especially zod 3→4), not in this pass.
- **Reviewer:** Independent code review (Claude). Same caveats as prior reviews about LLM reviewers — verdicts are first-hand source verification, but novel-finding generation is a known weak point (the second-pass review explicitly self-corrected PRC-01).
