# P3 plan — outreach-api-mcp (resume-from-cold)

Self-contained brief so a fresh-context agent can pick up where we left off without re-reading the whole transcript. Source of truth for the actual finding list is `REMEDIATION-v0.1.1.md §"Priority 3"` (lines 70–77).

## State as of 2026-06-07

- **Branch model:** `main` is stable. Each priority bucket ships as one PR off a `fix/<bucket>-fastfollows` branch.
- **Shipped already:**
  - PR #6, #7 — first-pass blockers (v0.1.1 cut)
  - PR #7 — **P1 fast-follows** (NEW-3, NEW-1, NEW-7) — merged
  - **PR #11 — P2 fast-follows (NEW-8, NEW-2, COR-08, SEC-02, NEW-4/5/6)** — open, awaiting CI + Joe's merge
- **Versions:** package.json is at `0.1.1`. No bump for P2; consider `0.1.2` after P3 lands.
- **Worktree:** `/Users/jobot/code/outreach-api-mcp/outreach-worker/` (the npm package lives one level down from the repo root).
- **Verify:** `cd outreach-worker && npm run verify` = check + lint + format:check + test + build. Currently 230/230 tests pass.

## Hard rules (from Joe, do not violate)

1. **No `Co-Authored-By: Claude` trailer** on any commit — anywhere, any repo. Joe is sole contributor on his GitHub footprint.
2. **One commit per finding.** Subject MUST be prefixed with the finding ID (e.g. `fix(COR-05): ...`). Body references the ID.
3. **No unrelated changes** mixed into a finding's commit. No drive-by cleanups.
4. **Every fix needs a test that fails without the fix.** Assert outgoing filters via `env.countCalls` / `env.listCalls`, not seeded count values (the stub returns seeded counts ignoring filters, so value assertions are false-greens).
5. **No new `any`, no new non-null `!`, no unjustified `as`, no `console.*` in `src/`.**
6. **Don't blindly run `npm run lint:fix`** — Joe got bitten by Node-version-sensitive import order. (Mostly mitigated by NEW-7, but stay alert.)
7. ~~**Don't push to remote without explicit instruction. Don't merge to main without confirmation.**~~ **Superseded 2026-06-12 by Standing Orders v2 (workspace `AGENTS.md` → Build Sessions program).** The operating agent now has standing authority to push and merge as part of authorized work. Joe-in-loop remains for force-push, npm publish/unpublish, public-visibility flips, repo/release delete, push to repos with paying users, and money-out-the-door. This document predates Standing Orders v2; see INF-01 in `REVIEW-v0.1.2.md`.
8. **This is NOT a Notion-Workers port for adopters.** Most users are net-new MCP authors. Frame docs and abstractions accordingly.

## Pre-flight before starting P3

1. Confirm PR #11 is merged. If not, ask Joe. Don't branch off un-merged P2.
2. `git checkout main && git pull` then `git checkout -b fix/p3-fastfollows`.
3. Re-read `REMEDIATION-v0.1.1.md §"Priority 3"` and `REVIEW.md §5` for context on each finding.
4. Sanity-check `npm run verify` is green on main before any changes.

## P3 buckets (cheapest-first per Joe's instinct)

### Bucket A — Tests (close §4.2 gap)
Pure additions, lowest risk. Good warm-up.

- **TST-01** — Add `tests/tools/blockC.test.ts` (templates/snippets) and `blockE.test.ts` (`draftEmail` — assert it returns a context bundle and NEVER a send affordance). Add the remaining 4 Block-B tools: `searchSequences`, `getSequenceProfile`, `getProspectSequenceHistory`, `compareSequences`.
- **TST-02** — Resolver lookup tests for ambiguous/0/1 matches. Likely in `tests/unit/tools/resolvers.test.ts` (new file).
- **TST-03** — Drive the OAuth loopback server itself, not just the pure helpers. Likely `tests/unit/auth/bootstrap.integration.test.ts`.
- **TST-05** — Direct `isAllowedResource` allowlist test in `tests/unit/api/`.

### Bucket B — Correctness
Behavioral fixes. Each needs an outgoing-filter assertion.

- **COR-05** — All five `search*` tools must report `truncated: false` on client-side fallback (compute from pre-slice size, not the API page state).
- **COR-06** — `compareSequences`: do not declare a winner at rate 0; one bad id must abort all (don't partial-credit).
- **COR-07** — Single-page caps drop matches in resolvers + `getTeamRoster` (roster caps at 500). Paginate or raise the cap with a truncation signal.
- **COR-09** — `analyzeSequencePerformance` count pre-flight swallows all errors into `tooLarge`. Copy the discrimination pattern from `getRecentMailings.ts:43-48` (catch `OutreachApiException` only; let programmer bugs propagate).
- **COR-10** — Reject negative `durationDays` with `validationError`.
- **COR-12** — `client.count` collapses the "couldn't count" case to `0`. Make it return `null` (or `-1` consistent with `safeCount`) so callers can distinguish "zero" from "unknown".

### Bucket C — Security / ops
- **SEC-03** — Implement the documented post-write `fstat` perm check in `auth/tokenCache.ts`, OR amend `SECURITY.md §2.3` to retract the claim. Prefer implement.
- **SEC-04** — Token-cache symlink / TOCTOU hardening (open with `O_NOFOLLOW` analogue + fstat verification).
- **SEC-05** — Add the stdout-pollution test that `STANDARDS.md §2.1` claims exists.
- **SEC-07** — Bootstrap callback server: `crypto.timingSafeEqual` for state comparison + `405` on non-GET.
- **PRC-02** — Either add a working `scripts/smoke:live.ts` or remove the `smoke:live` npm script (the file is missing — package.json references it).

### Bucket D — Design
- **DES-01** — Adopt-or-delete the dead `src/api/count.ts` and `src/api/pagination.ts`. Deleting also removes a latent pagination bug — verify nothing imports them first.
- **DES-02** — Consolidate duplicated `clamp` / `nameFromParts` / `isNonEmpty` into `_helpers.ts`.
- **DES-03** — Add §1.4 justification comments to existing `as` casts, OR narrow them (prefer narrow).
- **DES-04** — Truncate `draftEmail` template bodies to 5000 chars like the other tools.

## Suggested execution order

1. **Open with Bucket A** (TST-01 first — it surfaces other findings as you write the tests).
2. **Then Bucket B** in COR-id order, smallest first (COR-10 → COR-12 → COR-09 → COR-05 → COR-06 → COR-07).
3. **Then Bucket C** (SEC-03 first; SEC-04/05/07 are easier once the perm-check pattern is set).
4. **End with Bucket D** (refactor + cleanup is safer when behavior is locked down by new tests).

If context budget is tight: ship Buckets A + B as one PR, C + D as a second PR. Joe will tolerate two PRs if it keeps each one reviewable.

## PR shape

- **Title format:** `P3 fast-follows (TST-01, COR-05, …)` — mirror P1/P2.
- **Body:** table of `commit | ID | what it does` + test plan with per-finding regression-test bullet + CI checkbox.
- Open against `main`. Do not push without explicit instruction.

## After P3

Tag `v0.1.2` once Joe merges. Then the realistic next chunks (not in this plan, just trail markers):
- `REVIEW-v0.1.2.md` — third-pass review.
- Public-MCP polish: README walkthrough for the net-new MCP author (NOT a Notion-Worker porter), example `claude_desktop_config.json`, screenshot of bootstrap.
- npm publish prep.
