# Remediation brief — `outreach-api-mcp` v0.1.1 → next

> Work order for the implementing agent. Derived from [`REVIEW-v0.1.1.md`](./REVIEW-v0.1.1.md) (second pass) and [`REVIEW.md`](./REVIEW.md) (first pass).
> Base commit: `60d5192` (`main`). Every item cites a stable finding ID and a `file:line`.

## 0. Ground rules (read before touching code)

1. **Grade against `STANDARDS.md`.** It is the contract. If a fix conflicts with a standard, either follow the standard or update the doc in the same PR — don't ignore it.
2. **Green gate = `npm run verify` on the supported matrix.** CI runs Node **20 and 22**. `engines` is `>=20.11`. Your local Node may differ — see **NEW-7**: lint ordering is currently Node-version-sensitive, so **do not run `npm run lint:fix` blindly** and assume it's right; verify `eslint .` is clean on Node 20 *and* 22 (CI is the source of truth). Fix NEW-7 first if you're developing on Node ≥ 23.
3. **Tests must actually guard the fix.** The stub (`tests/fixtures/stubOutreachClient.ts`) applies filter semantics now — but `count()` returns a **seeded `count` override verbatim, ignoring filters** (`:77-78`). So a `mailingsSent === 5` assertion is *not* filter-sensitive. **Assert scoping via `env.countCalls` / `env.listCalls` filters**, the way `blockA.test.ts:245-253` does — not via the count value. A test that would still pass with the bug reintroduced is not done.
4. **One commit per finding**, subject prefixed with the ID, e.g. `fix(NEW-1): signal truncation when account prospect set is capped`. Reference the ID in the body. Keep unrelated changes out (STANDARDS §7.1).
5. **Don't regress what's fixed.** The v0.1.1 fixes (COR-01..04, SEC-01/06, AVL-01/02/03, TST-04) are verified resolved; the blocker bar is already cleared. This brief is fast-follows + backlog, not a re-do.
6. After each item: `npm run verify` must pass, and add/adjust the named test.

---

## Priority 1 — fast-follows (do before tagging 1.0)

### NEW-3 · Medium · residual SEC-01 leak (smallest, highest value — do first)
- **Where:** `src/schema/customFields.ts:57-59`.
- **Problem:** `logger.warn("schema.cache.load.failed", { message: e instanceof Error ? e.message : String(e) })` logs the message **without `redact()`**. On a `/types` fetch failure, `client.ts:219` throws `outreachApiError(status, text.slice(0, 200))` whose `.message` embeds up to 200 chars of the raw upstream response body (`envelopes.ts:204`) → reaches stderr unscrubbed. The structured logger does **not** auto-scrub; only ctx wrapped in `redact()` is scrubbed (`logger.ts:51-60`).
- **Fix (pick one):**
  - Minimal: `message: redact(e instanceof Error ? e.message : String(e))` (import `redact` from `../logger.js`).
  - **Preferred (defense-in-depth, closes the whole class):** move the scrub into `emit()` so every log line is scrubbed regardless of whether the caller remembered — i.e. apply the value-scrubber to the serialized `ctx` inside `logger.ts:emit`, and drop the now-redundant per-call `redact()` wrapping in `_helpers.ts` (or keep it, harmless). If you do this, also fixes any future forgotten call site.
- **Acceptance:** new unit test in `tests/unit/schema/customFields.test.ts` (or `logger.test.ts`): force `fetchTypes` to throw an error whose message contains `Bearer abc.def.ghi` / `access_token=secret`, trigger the cache load, capture stderr, assert the emitted `schema.cache.load.failed` line contains `[REDACTED]` and **not** the token. `npm run verify` green.

### NEW-1 · Medium · account activity counts undercount large accounts
- **Where:** `src/tools/getAccountProfile.ts:69` (`pageSize: 50`), `:95` (`pageSize: 500`), `:100-135`.
- **Problem:** Counts are correctly scoped by `prospect: relId(prospectIds)` now — but `prospectIds` come from a single un-paginated page: **top 50 by engagement** when `includeProspects` defaults true, **first 500** when false. So (a) accounts with > 50 prospects undercount silently, (b) the *same account* returns different numbers depending on `includeProspects`, and (c) there is no truncation signal in `recentActivity`.
- **Fix:**
  - Use **one consistent** scope source regardless of `includeProspects` (don't let the flag change the denominator). Fetch the account's prospect IDs via a dedicated ID-only call with a clear cap (e.g. `MAX_SCOPE_PROSPECTS`), and **follow `nextCursor`** up to that cap.
  - When the prospect set is capped (more exist than fetched), set `recentActivity.truncated = true` and a note like `"Activity counts cover the first N prospects of this account; narrow by sub-segment for exact figures."` Don't silently undercount.
  - Remove the dead ternary at `:113-114` (`count: noProspects && includeRecentActivity ? 0 : 0` → just `0`) — **NEW-9**.
- **Acceptance:** test in `blockA.test.ts` (or new `blockC`-style file): seed an account with more prospects than the cap; assert `recentActivity.truncated === true` (and that the count scope filter still carries `prospect: relId([...])` via `env.countCalls`). Note: the stub returns `nextCursor: null`, so to exercise the cap you'll need to **extend the stub** to return a cursor when `pageSize < seeded rows` (small addition to `stubOutreachClient.ts:list`), or assert the cap via the recorded `listCalls` pageSize + a documented invariant. Make the assertion filter/cap-sensitive, not value-based (Ground rule 3).

### NEW-7 · Medium · lint is non-deterministic across Node versions
- **Where:** `eslint.config.js:62-69` (the `import/order` rule); manifests in `src/api/client.ts:18-40`.
- **Problem:** `import/order` uses `alphabetize: { order: "asc" }` with `groups: [["builtin","external"], "internal", ["parent","sibling","index"]]`. Parent (`../`) and sibling (`./`) are in **one** group and alphabetized together; the `.`-vs-`/` collation differs by ICU/Node version, so `../auth` sorts before `./filters` on Node 20/22 (CI green) but the reverse on Node 25 (local fail). A `lint:fix` on one Node version produces an order that fails the other.
- **Fix (preferred):** split parent/sibling/index into **separate** ordered groups so group order (not cross-punctuation collation) decides parent-before-sibling, and alphabetize only *within* each group:
  ```js
  groups: [["builtin", "external"], "internal", "parent", "sibling", "index"],
  ```
  `client.ts` already lists parents before siblings, so this should pass with **no source reorder** — but verify. Alternatives if that doesn't fully stabilize: add `eslint-import-resolver-typescript` (pin `.js`→`.ts` resolution) and/or set `pathGroups`; or cap `engines` to the tested range and document Node 20/22 as the supported dev matrix.
- **Acceptance:** `eslint .` exits 0 on **Node 20, 22, and 23+** (test at least two majors). `npm run verify` green in CI. Don't introduce churn in unrelated files.

---

## Priority 2 — same pass (cheap correctness / consistency)

### NEW-2 · Medium/Low · AVL-03 gaps left by the fix
- `src/tools/getAccountProfile.ts:55-98,138-147` — phase-1 `prospect`/`opportunity` list fetches and the `activeStates` fetch are still bare `await`/`Promise.all`; one `scopeMissing`/timeout/5xx collapses the whole tool. Wrap the optional ones with the same `optional()` helper used in `getProspectProfile.ts:36-41` (keep `account.get` hard).
- `src/tools/getSequenceProfile.ts:165-171` — the tail `allStates` try/catch degrades only on `isScopeMissing`; a **timeout/5xx** there still throws. Broaden to degrade on any failure into `unavailableSections` (or reuse `optional()`), for consistency with the other composing tools.
- **Acceptance:** `failOn` tests (the stub supports `failOn.list/get/count`, `stubOutreachClient.ts:23-28`) for getAccountProfile (a failing `opportunity` list → tool still returns account + `unavailableSections`) and getSequenceProfile (a non-scope error on `sequenceState` → degraded, not thrown).

### NEW-8 · Low · `optional()` swallows all errors
- `src/tools/getProspectProfile.ts:37`, `draftEmail.ts:35` — the bare `.catch` also catches genuine programmer errors (e.g. a `TypeError` in the call setup) and mislabels them "section unavailable." Narrow it: only degrade on `OutreachApiException` (and/or `AuthError`); rethrow anything else. Mirrors `getSequenceProfile`'s discrimination.

### COR-08 · Medium · no date validation (unblocks several tools; cheap shared helper)
- `src/index.ts` date params are bare `j.string().nullable()`; tools interpolate `from`/`to` straight into filters, and `getAuditLog.daySpan` calls `new Date()` on unvalidated input. Add one shared helper (e.g. in `_helpers.ts`): validate ISO `YYYY-MM-DD` (or full ISO), enforce `from <= to`, return `validationError` otherwise. Apply in `analyzeSequencePerformance`, `getUserActivity`, `getRecentMailings`, `getAuditLog`.
- **Acceptance:** unit/integration test: `from > to` and a non-date string each return `validationError`.

### Redaction polish (NEW-4 / NEW-5 / NEW-6 / SEC-02) — `src/logger.ts`
- **SEC-02 (Medium):** drop the bare generic keys `state`, `code`, `token`, `bearer` from `REDACT_KEYS` (`:71-75`) — they clobber legitimate Outreach domain values. Keep `access_token`/`refresh_token`/`client_secret`/`authorization`/`code_verifier`. Update `logger.test.ts:84-100` accordingly (it currently asserts the bare keys are redacted).
- **NEW-5 (Low):** the form scrubber (`:92`) matching bare `code=`/`state=`/`token=` over-redacts free text (e.g. a note "promo code=X"). Tighten to OAuth-context only or accept the trade-off and document it.
- **NEW-4 (Medium, residual):** the scrubber is signature-based; an **opaque** token with no `Bearer `/`key=`/JWT framing still leaks. Lower priority (no clean general fix), but note it: the realistic surface is now small because envelopes are redacted and known shapes are caught.
- **NEW-6 (Low):** `redactValue` never pops the `WeakSet` (`:107-122`), so a shared *acyclic* reference renders `[Circular]`. Fix with `seen.delete(input)` before returning, or use a path-local set. Add a test: `{a: shared, b: shared}` → both rendered, neither `[Circular]`.

---

## Priority 3 — backlog (open from first pass; schedule as capacity allows)

None are blockers; all are documented in `REVIEW.md §5`. Grouped by cheapest-first:

- **Tests (close the §4.2 gap):** **TST-01** add `blockC` (templates/snippets) and `blockE` (`draftEmail` — assert it returns a context bundle and never a send affordance) integration tests, and the remaining 4 Block-B tools (`searchSequences`, `getSequenceProfile`, `getProspectSequenceHistory`, `compareSequences`). **TST-02** resolver lookups (ambiguous/0/1). **TST-03** drive the OAuth loopback server (not just the pure helpers). **TST-05** a direct `isAllowedResource` allowlist test.
- **Correctness:** **COR-05** all five `search*` tools report `truncated:false` on the client-side fallback (compute from pre-slice size). **COR-06** `compareSequences` declares a winner at rate 0 / one bad id aborts all. **COR-07** single-page caps drop matches (resolvers, `getTeamRoster` — its whole roster caps at 500). **COR-09** `analyzeSequencePerformance` count pre-flight swallows all errors into `tooLarge` (copy the `getRecentMailings.ts:43-48` pattern). **COR-10** negative `durationDays`. **COR-12** `client.count` collapses the "couldn't count" case to `0`.
- **Security/ops:** **SEC-03** implement the documented post-write `fstat` perm check in `tokenCache.ts` (or amend §2.3). **SEC-05** add the stdout-pollution test §2.1 claims exists. **SEC-04** token-cache symlink/TOCTOU hardening. **SEC-07** bootstrap `crypto.timingSafeEqual` + `405` on non-GET. **PRC-02** add or remove the `smoke:live` script (file is missing).
- **Design:** **DES-01** adopt-or-delete the dead `api/count.ts` / `api/pagination.ts` (deleting also removes a latent pagination bug). **DES-02** consolidate duplicated `clamp`/`nameFromParts`/`isNonEmpty` into `_helpers.ts`. **DES-04** truncate `draftEmail` template bodies to 5000 like the other tools. **DES-03** add the §1.4 justification comments (or narrow) the `as` casts.

---

## Definition of done (per item)
- [ ] Fix at the cited `file:line`, matching surrounding style and `STANDARDS.md`.
- [ ] Test added/updated that **fails without the fix** (assert behavior/outgoing filters, not seeded values).
- [ ] `npm run verify` green locally on Node 20 **and** 22 (after NEW-7, also confirm your dev Node).
- [ ] CI green on the PR (Node 20 + 22 matrix).
- [ ] Commit subject prefixed with the finding ID; body references it.
- [ ] No unrelated changes; no new `any`/non-null/unjustified `as`; no `console.*` in `src/`.

## Verify
```bash
cd outreach-worker
npm ci
npm run verify          # check + lint + format:check + test(+coverage) + build
```
Update `REVIEW-v0.1.1.md`'s verdict table (or note in the PR) as each ID closes.
