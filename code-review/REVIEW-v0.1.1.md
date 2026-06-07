# Code Review — `outreach-api-mcp` v0.1.1 (second pass)

> Verification review of the blocker-fix commits between `651ca6a` and `60d5192`.
> Baseline: [`code-review/REVIEW.md`](./REVIEW.md) (first pass — 35 findings, 9 release blockers).
> Read against the project's own `STANDARDS.md` / `SECURITY.md`.

## Document control

| Field | Value |
|---|---|
| **Artifact** | `outreach-api-mcp` / `outreach-worker` |
| **HEAD reviewed** | `60d5192` — branch `main` |
| **Fix commits in scope** | `2b9c8c8` (AVL-01/02/05), `21e4a80` (SEC-01/06), `fa03014` (COR-01..04, TST-04), `60d5192` (AVL-03) |
| **Review date** | 2026-05-31 |
| **Method** | Pipeline executed on a clean `npm ci`; CI status checked via GitHub API; every blocker re-verified first-hand at the cited locations; two independent adversarial verifiers (regression sweep + redaction/test-quality) whose findings were spot-checked. |
| **Verification** | Every verdict below was confirmed in source by the lead reviewer. |

### Release recommendation

**The release-blocker bar is cleared — v0.1.1 is shippable, with three recommended fast-follows.**

The four worst-class data-integrity bugs (silent wrong-but-plausible output) and both availability defects are **genuinely fixed and guarded by real regression tests** that fail if the bug returns. No finding from this pass rises to a release blocker. The residuals are all **Medium or below** — chiefly a *new* undercount in `getAccountProfile` (scoping is now correct but capped) and one **missed log site that still leaks** (the SEC-01 fix didn't cover `customFields.ts`). Recommended fast-follows before a `1.0`: **NEW-1** (account-count cap + truncation signal), **NEW-3** (`customFields` redact bypass), **NEW-7** (cross-Node lint determinism).

One correction to the first pass: **PRC-01 ("repo fails its own lint gate / CI would be red") was wrong** — it was an artifact of running an unsupported Node version locally. CI is and was green on the tested matrix. Details in §1 and NEW-7. I flag my own error explicitly, as I did the subagent's in pass 1.

---

## 1. Pipeline & CI status (run first-hand at `60d5192`)

| Gate | Local (`npm run …`) | GitHub CI (Node 20 + 22) |
|---|---|---|
| check (tsc) | ✅ pass | ✅ pass |
| **lint (eslint)** | ❌ **3 `import/order` errors** | ✅ **pass** |
| format | ✅ pass | ✅ pass |
| test | ✅ 211 pass / 20 files | ✅ pass |
| coverage (measured) | ✅ 92.4 / 87.6 / 93.8 / 95.7 | ✅ pass |
| build | ✅ pass | ✅ pass |
| audit (high+) | — | ✅ pass |

CI conclusion is **`success` on both Node 20 and Node 22** at `60d5192` (verified via the Checks API; the only annotation is an unrelated Node-20-runner-deprecation warning), and CI was likewise green at the originally-reviewed `651ca6a`. The local lint failure reproduces my first-pass result **but only because my environment is Node 25.8.1**, outside the project's tested matrix — see **NEW-7**. This is why my original PRC-01 framing was incorrect.

---

## 2. Blocker verification (the 9 release blockers from REVIEW.md §4)

| ID | Claim | Verdict | Evidence (HEAD `60d5192`) |
|---|---|---|---|
| **COR-01** | `getAuditLog` applies the date range client-side | **✅ Resolved** (documented residual) | `getAuditLog.ts:58-103` derives `fromTs/toTs`, filters on `occurredAt ?? createdAt`, gate now includes the date branch. Residual: filter runs over the most-recent fetched page only (no server-side date filter) — a window older than the latest N entries returns `[]` signalled only by `truncated`. Honestly documented in the `note`. Guard test: `blockD.test.ts:75-107`. |
| **COR-02** | `getAccountProfile` scopes counts by the account's prospects | **⚠️ Resolved-with-new-issue** | `getAccountProfile.ts:107-135` scopes every count by `prospect: relId(prospectIds)`. Workspace-wide bug gone. **But** see **NEW-1** (capped, flag-dependent prospect set → undercount) and **NEW-2** (phase-1 fetches still unwrapped). Guard test: `blockA.test.ts:245-253` asserts the outgoing `{__relId:[1,2]}` filter. |
| **COR-03** | `getUserActivity` scopes mailings via mailbox; null + note when scope missing | **✅ Resolved** | `getUserActivity.ts:60-98,201-206` fetches the user's mailboxes, scopes mailing counts by `mailbox: relId([...])`, returns `null` + `mailingNote` when `mailboxes.read` is absent. |
| **COR-04** | Engagement numerators gated on delivery | **✅ Resolved** | `analyzeSequencePerformance.ts:174-200` — `opened/clicked/replied` require `delivered` in **both** the totals and per-group loops; numerator ⊆ denominator. Guard test: `blockB.test.ts:16-68` (bounced-but-opened → `opened=1`, `openRate=1`). |
| **SEC-01** | `redact()` scrubs token-shaped values; `runTool` redacts the envelope | **⚠️ Mostly resolved** | `logger.ts:88-122` adds Bearer/form/JWT value-scrubbers + recursion; `_helpers.ts:77,97` now `redact()`s both envelopes. **But** see **NEW-3** (an un-redacted log site still leaks), **NEW-4** (opaque tokens), **NEW-5** (over-redaction). Guard tests: `logger.test.ts:128-173`. |
| **SEC-06** | Circular-ref guard in `redact()` | **✅ Resolved** (Low residual) | `logger.ts:107-122` threads a `WeakSet`; cyclic input → `[Circular]`, no overflow. Residual: shared *acyclic* refs also render `[Circular]` (**NEW-6**, Low). |
| **AVL-01** | Cap Retry-After / pacing at 60s; surface `rateLimited` over cap | **✅ Resolved** | `client.ts:276-279` throws `rateLimited(wait)` without sleeping when `wait > 60`; `rateLimit.ts:65` clamps pacing via `Math.min(raw, 60)`; `limit<=0` guarded (`rateLimit.ts:55`, AVL-05). Caps consistent (both 60). New tests in `client.test.ts`/`rateLimit.test.ts`. |
| **AVL-02** | Every fetch carries a timeout; AbortError → `timeout` envelope | **✅ Resolved** | `client.ts:325` `signal: AbortSignal.timeout(30_000)` on the sole fetch funnel (covers list/get/count/fetchTypes); `:327-330` maps abort → `timeout()` and **rethrows non-abort**; `isAbortError` (`:368`) catches both `AbortError` and the `TimeoutError` that `AbortSignal.timeout` actually throws (runtime-confirmed `DOMException instanceof Error`). |
| **AVL-03** | Optional sub-fetches degrade into `unavailableSections` | **⚠️ Resolved for the 3 named tools; gaps elsewhere** | `getProspectProfile.ts:36-41` and `draftEmail.ts:34-39` add `optional(p,label,fallback)`; core `prospect.get` left hard (correct). `getSequenceProfile.ts:155-172` wraps its tail. **But** see **NEW-2**: `getAccountProfile` was *not* wrapped (REVIEW.md explicitly asked for it), and the `getSequenceProfile` tail degrades only on `scopeMissing`, not timeout/5xx. Guard test: `blockA.test.ts:69-110` (`failOn`). |
| **PRC-01** | (Author: "stale — CI green at HEAD") | **↩️ Original finding withdrawn; replaced by NEW-7** | CI is green on Node 20/22 (verified, incl. at `651ca6a`). My first-pass "CI would be red" was a Node-25-local artifact and is **incorrect**. The real, narrower issue is cross-Node lint non-determinism — **NEW-7**. |

**Score:** 6 clean resolutions (COR-03, COR-04, SEC-06, AVL-01, AVL-02, TST-04), 3 resolved-with-residual (COR-01, COR-02, SEC-01, AVL-03), 1 corrected (PRC-01). The catastrophic-wrong-data and hang-the-server failure modes are gone.

**TST-04 (the test-stub hardening):** **✅ Resolved.** `stubOutreachClient.ts:95-138` now applies relId / ISO-range / array / literal filter semantics, and `count()` filters too. The two tests that previously *encoded the bugs as correct* are now genuine guards: `blockA.test.ts:245-253` (COR-02, asserts the `prospect` filter via `env.countCalls`) and `blockD.test.ts:104-106` (COR-01, asserts the out-of-range entry is excluded). Both fail if the respective bug returns.

---

## 3. New findings introduced or surfaced by the fixes

| ID | Severity | Title | Location |
|---|---|---|---|
| NEW-1 | Medium | `getAccountProfile` activity counts scoped to a **capped** prospect set → undercount for large accounts; cap differs by flag; no truncation signal | `getAccountProfile.ts:69,95,100-135` |
| NEW-2 | Medium | AVL-03 incomplete: `getAccountProfile` phase-1 fetches still bare `Promise.all`; `getSequenceProfile` tail degrades on scope-missing only (not timeout/5xx) | `getAccountProfile.ts:55-98,138-147`; `getSequenceProfile.ts:165-171` |
| NEW-3 | Medium | SEC-01 bypass: `customFields` logs a raw exception message **without `redact()`** — up to 200 chars of an upstream `/types` response body reach stderr | `schema/customFields.ts:57-59` (feeder: `client.ts:219`, `envelopes.ts:204`) |
| NEW-4 | Medium | SEC-01 residual under-redaction: the scrubber is signature-based (Bearer / `key=` / JWT); an **opaque** token in a benign-key value with no framing still leaks | `logger.ts:88-95` |
| NEW-5 | Low | SEC-01 over-redaction: form scrubber matches bare `code=`/`state=`/`token=` anywhere → corrupts legitimate free-text (e.g. a note "promo code=…") logged via `errorEnvelope` | `logger.ts:92` |
| NEW-6 | Low | SEC-06 `WeakSet` is never popped → a shared **acyclic** reference renders as `[Circular]` (false positive; drops diagnostic data) | `logger.ts:107-122` |
| NEW-7 | Medium | **Lint is non-deterministic across Node versions.** `import/order` `alphabetize` uses locale collation; `../`-vs-`./` ordering differs by ICU/Node. CI (20/22) passes; Node 25 fails — and a `lint:fix` on one would break the other. `npm run verify` is not portable to current Node. | `eslint.config.js:62-69`; `client.ts:18-40` |
| NEW-8 | Low | `optional()` catches **all** rejections — a genuine programmer error in a wrapped sub-fetch is silently mislabeled "section unavailable" rather than surfaced | `getProspectProfile.ts:37`; `draftEmail.ts:35` |
| NEW-9 | Info | Dead no-op ternary `count: noProspects && includeRecentActivity ? 0 : 0` (both branches `0`) | `getAccountProfile.ts:113-114` |
| NEW-10 | Low | Test-infra false-green trap: stub `count()` returns a seeded override **ignoring filters**, and `matches()` treats nested `filter[k][sub]` as always-true. COR-02's count-*value* assertion is filter-insensitive; protection rests solely on the `countCalls` assertion. | `stubOutreachClient.ts:77-81,125-128` |

### Detail on the three fast-follow items

**NEW-1 — account activity counts undercount for large accounts.**
`prospectIds` come from the prospect list, which is fetched at `pageSize: 50` when `includeProspects` defaults true (`getAccountProfile.ts:69`, sorted `-engagedScore`) or `pageSize: 500` when `includeProspects=false` (`:95`). Neither follows `nextCursor`. So for an account with >50 prospects, all four counts are scoped to the **top 50 by engagement** (or first 500), and the *same account* returns **different** numbers depending on the `includeProspects` flag — with no `truncated`/`unavailable` signal in `recentActivity`. This trades the old loud-and-obvious workspace-wide overcount for a quieter, plausible undercount. Fix: derive scope IDs from a paginated/`count`-based source, or surface a truncation flag when the prospect set is capped. (Invisible to the test suite — the stub returns `nextCursor: null`.)

**NEW-3 — residual SEC-01 leak the fix missed.** The logger does **not** auto-scrub; only ctx wrapped in `redact()` is scrubbed (`logger.ts:51-60`). Every `runTool` site now wraps correctly, but `schema/customFields.ts:57-59` logs `message: e.message` directly. On a `/types` fetch failure, `client.ts:219` throws `outreachApiError(status, text.slice(0,200))` whose `.message` embeds up to 200 chars of the raw upstream body (`envelopes.ts:204`); `customFields` catches it and logs it unscrubbed. Same class of bug SEC-01 set out to close. Fix: `redact()` the message (or scrub inside `emit()` so no caller can forget).

**NEW-7 — cross-Node lint determinism (replaces PRC-01).** `import/order` is configured with `alphabetize: { order: "asc" }` (`eslint.config.js:66`); the parent (`../auth`) vs sibling (`./filters`) imports in `client.ts` sort one way under the ICU bundled with Node 20/22 and the opposite way under Node 25, because `localeCompare` orders the `.`/`/` boundary differently. Result: CI (20/22) is green, a contributor on current Node (25) gets 3 `import/order` errors from `npm run verify`, and `lint:fix` on Node 25 would reorder in a way that then fails CI. This breaks the "`verify` is the contract" / reproducibility intent (§6.2) for anyone off the pinned matrix. Fix options: disable punctuation-sensitive `alphabetize` (or set a deterministic comparator / `pathGroups`), add `eslint-import-resolver-typescript` to stabilize classification, or cap `engines` to the tested range and document it. Not a release blocker.

---

## 4. Status of the original Medium/Low backlog (untouched unless noted)

**Fixed in passing:** AVL-05 (`rateLimit` `limit<=0` guard) ✅.

**Marginally improved:** TST-01 — Block B now has one test (`analyzeSequencePerformance`); **Blocks C (templates/snippets) and E (`draftEmail`) still have no tests**, and 4 of 5 Block-B tools remain untested.

**Still open (not in scope of these commits; not blockers):** SEC-02 (bare `state`/`code`/`token` still in `REDACT_KEYS` — `logger.ts:71-75` — now compounded by the NEW-5 value over-redaction), SEC-03 (`fstat`), SEC-04 (token-cache symlink/TOCTOU), SEC-05 (stdout-pollution test), SEC-07 (bootstrap hardening), COR-05 (search `truncated`), COR-06 (`compareSequences`), COR-07 (page-size caps incl. `getTeamRoster`), COR-08 (date validation — explicitly still bare `j.string()` in `index.ts`), COR-09 (count pre-flight error swallow), COR-10/11/12, DES-01..05, TST-02/03/05. None regressed.

---

## 5. Standards delta vs first pass

| § | Was | Now |
|---|---|---|
| 2.2 (tokens/PII never logged) | ❌ Fail | ⚠️ Partial — value-scrubbing closes the common vectors; residual leak at `customFields.ts` (NEW-3) + opaque-token gap (NEW-4); SEC-02 over-redaction unchanged |
| 2.7 / availability | ❌ (unbounded sleep, no timeout) | ✅ bounded + timeout (AVL-01/02) |
| 4.2 (every block tested) | ❌ Fail | ⚠️ Partial — Block B partly covered; C/E still untested |
| 4.5 (deterministic / inject clock) | ⚠️ | ⚠️ — stub now filter-aware (big improvement); tools still read `new Date()` |
| 6.1 / 6.2 (CI green / reproducible) | (mis-reported as ❌) | ✅ CI green on 20/22; ⚠️ `verify` not portable to Node 25 (NEW-7) |

---

## 6. Revised recommendation

**Ship v0.1.1.** The release-blocking class is resolved: the four silent data-corruption tools now scope correctly (with the NEW-1 caveat), engagement rates are bounded ≤ 100%, the server can no longer be hung by a hostile `Retry-After` or a stalled socket, optional sub-fetches degrade gracefully in the three composing tools, the logger scrubs the common token vectors, and the previously-buggy tests are now genuine regression guards. CI is green on the supported matrix.

**Fast-follow (recommended before 1.0, none blocking):**
1. **NEW-3** — `redact()` the `customFields` log (smallest, highest-value: closes the one remaining SEC-01 leak). Consider scrubbing inside `emit()` so the contract can't be forgotten.
2. **NEW-1** — make the account-activity prospect scope paginated or signal truncation; resolve the flag-dependent cap.
3. **NEW-7** — make `import/order` deterministic across Node versions (or cap `engines`) so `npm run verify` is portable.
4. Opportunistic: **NEW-2** (wrap `getAccountProfile`/harden the `getSequenceProfile` tail for timeouts), **NEW-4/5/6** (redaction polish), and chip at the TST-01 gap (Block C/E tests).

---

## 7. Scope & limitations

Static review + pipeline execution + GitHub CI status check; no live Outreach calls. Every verdict in §2 and every NEW finding was confirmed first-hand in source at `60d5192` (the lead reviewer read the final state of all four fixed tools, `client.ts`, `rateLimit.ts`, `logger.ts`, `_helpers.ts`, `customFields.ts`, the three AVL-03 tools, the hardened stub, and the new/updated `blockA/blockB/blockD`/`logger.test`/`client.test`/`rateLimit.test` tests), corroborated by two independent adversarial verifiers. Per the brief, resolved-and-untouched first-pass items were not re-litigated. The lint root-cause (ICU/`localeCompare` collation) is an inference strongly supported by: CI green on 20/22, local fail on Node 25, identical lockfile, and the `alphabetize` config — I did not bisect Node versions to isolate it further.

*Finding IDs (`COR-/SEC-/AVL-/TST-/DES-`) map to `REVIEW.md`. New IDs are `NEW-1..10`.*
