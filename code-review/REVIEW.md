# Code Review — `outreach-api-mcp`

> Independent technical code review of the `outreach-worker` MCP server.
> Graded against the project's own `STANDARDS.md` and `SECURITY.md`.

## Document control

| Field | Value |
|---|---|
| **Artifact** | `outreach-api-mcp` / `outreach-worker` (Model Context Protocol server for the Outreach v2 REST API) |
| **Commit reviewed** | `651ca6a` — branch `main` |
| **Review date** | 2026-05-31 |
| **Reviewer** | Independent code review (Claude) |
| **Review type** | Full-codebase static review + pipeline execution. **Not** a penetration test, a formal security audit/certification, or a dynamic/DAST assessment. |
| **Classification** | Internal — engineering |
| **Version** | 2.1 — every finding is now **first-hand verified** against source (the entire `src/` tree, `scripts/`, and all finding-relevant tests were read directly). v2.0 added the severity rubric / CWE framing; v1.0 was the initial pass. The gap-closure pass (v2.1) read the 8 previously reviewer-only tool files, the remaining `src` files, and the test suite — confirming all prior findings, generalizing COR-05 from one tool to five, adding COR-12, and surfacing two "smoking-gun" tests that encode COR-01/COR-02 as expected behavior. |

### Release recommendation

**Conditional go.** The architecture, security model, and primitive layers are of high quality and the project holds an exemplary internal standard. **Do not ship to production until the 9 items marked `Release blocker` are resolved** — chiefly four tools that silently return incorrect data, the logger PII/secret value-leak, two availability defects in the HTTP client, the `Promise.all` collapse, and a failing lint gate that currently breaks CI. None are architectural; all are localized and fixable within the existing design. Estimated remediation for the blocker set: **2–4 engineer-days** plus test authoring. Note that fixing COR-01 and COR-02 **requires updating two existing tests** that currently assert the buggy behavior (see TST-04).

---

## 1. Executive summary

`outreach-api-mcp` is a read-only MCP server exposing 21 tools over the Outreach v2 API. It is written to a deliberately high bar: strict TypeScript (all 7 claimed compiler flags verified on), pinned dependencies, a correct OAuth2 implementation (PKCE S256, CSRF `state`, refresh-token rotation, concurrent-refresh coalescing — all confirmed by reading both the code and its tests), a deny-by-default escape-hatch allowlist, and 197 passing tests whose measured layers clear the coverage thresholds.

This review identified **35 findings**: 0 Critical, 12 High, 13 Medium, 10 Low/Informational. They cluster into five themes:

1. **Silent data-integrity defects (highest business risk).** `getAuditLog` drops the date filter entirely; `getAccountProfile` and `getUserActivity` count activity workspace-wide instead of per-entity; `analyzeSequencePerformance` can report engagement rates above 100%; and **all five `search*` tools** report `truncated: false` even when results were capped (their client-side fallback hardcodes `nextCursor: null`). Because an LLM relays these values to users as fact, wrong-but-plausible output is the worst failure mode for this product.
2. **Sensitive-data logging.** The structured logger redacts by *key name only*; secrets/PII appearing in string *values* (error `detail` carrying a response body, echoed query input containing an email) reach `stderr` despite the "tokens never touch logs" standard.
3. **Availability under adverse upstream behavior.** The HTTP client sleeps for an uncapped, server-controlled `Retry-After` and issues `fetch` with no timeout — either can hang the single-threaded server indefinitely.
4. **Assurance gaps between documentation and implementation.** Three controls that `STANDARDS.md`/`SECURITY.md` claim are not implemented (a post-write `fstat` permission check, a stdout-pollution CI test) or are broken (`npm run smoke:live` references a missing file). The repository as cloned **fails its own `eslint` gate**, so CI on `main` would be red.
5. **Test blind spots that mask the above.** Three of five tool blocks (12 of 19 capability tools) have no integration test; the test stub **discards filters entirely**, so tests assert response *shape* but never the *filters sent*. Two tests (`blockA.test.ts:184` and `blockD.test.ts:75`) actively assert the COR-02 and COR-01 bugs **as correct** — concrete proof the gap is not theoretical.

The reassuring part: nothing here is architectural. The data-integrity bugs share one root cause (filters assembled without the entity/time scope the tool name promises) and are fixable as one focused pass; the test gap that hid them closes by asserting outgoing filters via the stub's existing (but unused) call-recording.

### Findings by severity

| Severity | Count | Release blockers |
|---|---|---|
| Critical | 0 | 0 |
| High | 12 | 9 |
| Medium | 13 | 0 |
| Low / Informational | 10 | 0 |
| **Total** | **35** | **9** |

---

## 2. Scope & methodology

**In scope:** the entire `outreach-worker` package at commit `651ca6a` — `src/` (auth, api, tools, config, errors, logger, schema, entrypoint), `scripts/`, `tests/`, build/lint/test configuration, the CI workflow, and the governance docs (`STANDARDS.md`, `SECURITY.md`, `README.md`).

**Method:**
1. **Pipeline execution** — ran the full gate (`tsc --noEmit`, `eslint`, `prettier --check`, `vitest run --coverage`, `tsc` build) on a clean `npm ci` and recorded results (§7).
2. **Parallel subsystem review** — six independent reviewers (auth, API client, two halves of the tool layer, core/infra, tests), each grading against `STANDARDS.md`.
3. **First-hand verification of 100% of findings** — the lead reviewer read every cited file directly. The gap-closure pass additionally read all 8 tool files not opened in earlier rounds, the remaining `src` files (`schema/customFields.ts`, `auth/scopes.ts`, `auth/index.ts`, the rest of `api/client.ts`), and the finding-relevant test files. One subagent claim ("no CI exists") was found **false** and is documented as a corrected error (§9).

**Verification status** is **Verified** for every finding in this version (see §9 for the precise read list and the small residual relied on via execution/coverage).

**Tooling versions:** Node (CI matrix 20/22), TypeScript 5.9.3, ESLint 9.39.4 + `typescript-eslint` 8.60.0 (+ `import`, `security`), Vitest 4.1.7, `@modelcontextprotocol/sdk` 1.29.0, zod 3.23.8.

---

## 3. Severity rubric

Severity reflects **technical impact × likelihood**, assessed for a **read-only** system (impact weights data integrity, confidentiality of credentials/PII, and availability).

| Severity | Definition |
|---|---|
| **Critical** | Remote/unauthenticated compromise, credential disclosure to an untrusted party by default, or unrecoverable data loss. |
| **High** | Silent data-integrity failure in a primary use case; credential/PII disclosure given a plausible precondition; denial of the running service; or a broken release gate. |
| **Medium** | Correctness defect in a secondary path or edge case; a documented control not implemented; defense-in-depth gap; a test gap that can let a High defect ship. |
| **Low** | Minor correctness/robustness issue with narrow impact; maintainability/standards deviation. |
| **Informational** | Style, consistency, or hardening suggestion with no functional impact. |

**Release blocker** is tracked *separately* from severity: it marks items that should gate a production release regardless of technical scale. Severity ≠ priority. Security findings carry a **CWE** reference and an exploitability/precondition note; CVSS vectors are omitted (this is a code review, not a scored pentest).

---

## 4. Findings register

| ID | Title | Severity | Blocker | CWE | Location |
|---|---|---|---|---|---|
| COR-01 | `getAuditLog` ignores the date range | High | ✅ | — | `src/tools/getAuditLog.ts:42-46` |
| COR-02 | `getAccountProfile` activity is workspace-wide | High | ✅ | — | `src/tools/getAccountProfile.ts:84-101` |
| COR-03 | `getUserActivity` mailing metrics are org-wide | High | ✅ | — | `src/tools/getUserActivity.ts:66-68` |
| COR-04 | Engagement rates can exceed 100% | High | ✅ | CWE-682 | `src/tools/analyzeSequencePerformance.ts:179-181,260-262` |
| SEC-01 | Logger redacts by key only; values leak | High | ✅ | CWE-532, CWE-359 | `src/logger.ts:90`; feeders `client.ts:219,234`, `_helpers.ts:69-95` |
| AVL-01 | Unbounded sleep on `Retry-After`/reset | High | ✅ | CWE-400 | `src/api/client.ts:249,266`; `rateLimit.ts:53` |
| AVL-02 | No request timeout on API `fetch` | High | ✅ | CWE-1088 | `src/api/client.ts:298-306` |
| AVL-03 | `Promise.all` collapses tool on one sub-fetch failure | High | ✅ | — | `src/tools/getProspectProfile.ts:30`; `draftEmail.ts:29` |
| PRC-01 | Repo fails its own lint gate → CI red | High | ✅ | — | `src/api/client.ts:32-39` |
| TST-01 | Tool blocks B, C, E untested (12/19 tools) | High | — | — | `tests/tools/` |
| TST-04 | Stub discards filters; two tests encode bugs as correct | High | — | — | `tests/fixtures/stubOutreachClient.ts:34-36`; `blockA.test.ts:184`; `blockD.test.ts:75` |
| SEC-03 | Token-permission `fstat` check (§2.3) not implemented | High | — | CWE-732 | `src/auth/tokenCache.ts:58-87` |
| COR-05 | All five `search*` tools never report `truncated` on the fallback path | Medium | — | — | `searchProspects.ts:171,227`; `searchAccounts.ts:98,133`; `searchSequences.ts:92,127`; `searchTemplates.ts:62,115`; `searchSnippets.ts:69,106` |
| COR-06 | `compareSequences` "winner" with zero signal; one bad id aborts all | Medium | — | — | `src/tools/compareSequences.ts:41-42,76-82` |
| COR-07 | Single-page caps silently drop matches (resolvers, fan-outs, `getTeamRoster`) | Medium | — | — | `_resolvers.ts:54,83,111`; `getTeamRoster.ts:15`; `searchProspects.ts:241` |
| COR-08 | No date validation / `from > to` guard | Medium | — | CWE-20 | `src/index.ts` schemas; multiple tools |
| COR-09 | Count pre-flight swallows all errors into `tooLarge` | Medium | — | — | `src/tools/analyzeSequencePerformance.ts:80-88` |
| SEC-02 | Logger over-redacts domain fields (`state`/`code`/`token`) | Medium | — | — | `src/logger.ts:71-75` |
| SEC-05 | stdout-pollution check (§2.1) absent in CI and tests | Medium | — | — | `.github/workflows/ci.yml`; `tests/unit/logger.test.ts:33-41` |
| DES-01 | Dead modules `count.ts` / `pagination.ts`; pagination drop-last-page bug | Medium | — | — | `src/api/count.ts`; `src/api/pagination.ts:74-84` |
| DES-04 | `draftEmail` returns untruncated template bodies | Medium | — | — | `src/tools/draftEmail.ts:173-174` |
| AVL-04 | OAuth couples request success to cache-write success (untested) | Medium | — | — | `src/auth/oauth.ts:164-179` |
| TST-02 | Name-resolver lookups untested | Medium | — | — | `tests/tools/blockA.test.ts:47` |
| TST-03 | OAuth loopback callback server untested | Medium | — | — | `scripts/bootstrap-oauth.ts:101-142`; `tests/unit/auth/bootstrap.test.ts` |
| TST-05 | Deny-by-default allowlist not directly tested | Medium | — | — | `tests/tools/escapeHatches.test.ts:22,72` |
| COR-10 | `getProspectSequenceHistory` can report negative duration | Low | — | — | `src/tools/getProspectSequenceHistory.ts:46-49` |
| COR-11 | `coerceId` precision loss for IDs > 2^53 | Low | — | — | `src/api/jsonapi.ts:175-182` |
| COR-12 | `client.count` collapses the "couldn't count" case to `0` | Low | — | — | `src/api/client.ts:181-184` |
| SEC-04 | Token cache: symlink-follow / TOCTOU; intermediate-dir perms | Low | — | CWE-367, CWE-59, CWE-377 | `src/auth/tokenCache.ts:59-86` |
| SEC-06 | `redact()` has no circular-reference guard | Low | — | CWE-674 | `src/logger.ts:82-93` |
| SEC-07 | Bootstrap: non-constant-time state compare; no method check; error-body echo | Low/Info | — | CWE-208, CWE-209 | `bootstrap.ts:81`; `bootstrap-oauth.ts:105,141` |
| AVL-05 | `recommendDelaySeconds` NaN when `limit === 0` | Low | — | — | `src/api/rateLimit.ts:50` |
| PRC-02 | `npm run smoke:live` references a missing script | Low | — | — | `package.json`; `scripts/` |
| DES-02 | Duplicated helpers (`clamp`/`nameFromParts`/`isNonEmpty`) | Low | — | — | ~10 tool files |
| DES-03 | `as` casts without the §1.4-required justification | Low | — | — | `index.ts`; many tools; `client.ts:236` |
| DES-05 | Misc nits (pluralization, surrogate split, magic date, dual plural maps, allowlist⊋scopes, dead fields, `groupBy` enum, loose scope regex, read-only-by-literal) | Info | — | — | various |

---

## 5. Detailed findings

### 5.1 Correctness — data integrity

#### COR-01 — `getAuditLog` ignores the date range entirely · High · Release blocker
**Location:** `src/tools/getAuditLog.ts:42-46` (client-side filter at `:55-84`).

Validation requires `resourceId`, `userId`, **or** a ≤30-day date range (`narrowDateRange`); the query then runs with **empty** filters and a client-side filter that keys only on `resourceId`/`resourceType`/`userId` — never the date.

```ts
const narrowDateRange = from !== … && to !== … && daySpan(from, to) <= NARROW_DAYS;
if (!hasResource && !hasUser && !narrowDateRange) { return validationError(…); }
const filters: FilterMap = {};                 // ← date never added
const result = await client.list("auditLog", { filters, pageSize: limit });
```

**Impact:** A date-range-only query — the most common audit question ("what changed last week") — passes validation and returns the most recent `limit` entries with **no date scoping**, presented as if they matched. For an audit/compliance surface this carries reporting risk. The guardrail is cosmetic.
**Evidence it shipped:** `tests/tools/blockD.test.ts:75-90` seeds two entries, calls `getAuditLog({ dateRangeFrom, dateRangeTo })`, and asserts `entries.length === 2` — passing only because neither the stub nor the tool applies a date filter.
**Remediation:** Filter entries to `[from, to]` client-side (mirroring the other filters) or apply a server-side date filter if supported; update the blockD test to seed dated entries and assert out-of-range exclusion. **Effort:** S.

#### COR-02 — `getAccountProfile` activity rollup is workspace-wide · High · Release blocker
**Location:** `src/tools/getAccountProfile.ts:84-101`.

None of the four `recentActivity` counts are scoped to the account: `mailing`/`task`/`sequenceState` filter only by `createdAt`; `call` uses an empty filter (`{}`) — all calls, all-time.
**Impact:** The advertised per-account "last-30-days activity rollup" returns workspace-global numbers, identical for every account.
**Evidence it shipped:** `tests/tools/blockA.test.ts:184-194` seeds `count: { mailing: 5 … }` and asserts `recentActivity.mailingsSent === 5` — passing only because the stub ignores the (missing) account filter.
**Remediation:** Scope each count (`account: relId(id)`, or `prospect: relId(prospectIds)` where no direct relation exists) and add a `createdAt` range to `call`; verify each resource's account relationship against the Outreach schema. Update the test to assert the scoped filter via `client.countCalls`. **Effort:** S–M.

#### COR-03 — `getUserActivity` mailing metrics are org-wide · High · Release blocker
**Location:** `src/tools/getUserActivity.ts:66-68`. The three mailing counts filter by date only — no `user`/`owner`/`mailbox` scope — while the adjacent `call` (`{ user: relId(userId) }`) and `task` (`{ owner: relId(userId) }`) are correctly scoped. A single rep's mailing numbers are the whole org's. **Remediation:** scope via the mailing→mailbox/user relationship, or return `null` with a note if unavailable. **Effort:** M.

#### COR-04 — Engagement rates can exceed 100% · High · Release blocker · CWE-682
**Location:** `analyzeSequencePerformance.ts:179-181` vs `:254-262`. `opened`/`clicked`/`replied` increment for any mailing with that timestamp, but the denominator `delivered` excludes bounced/undelivered mail; a bounced-but-opened mailing pushes `openRate` over 1.0. (Div-by-zero is correctly guarded.) **Remediation:** gate numerators on delivery, or use a "sent" denominator consistently. **Effort:** S.

#### COR-05 — All five `search*` tools never report `truncated` on the client-side fallback path · Medium
**Location:** `searchProspects.ts:171,227`; `searchAccounts.ts:98,133`; `searchSequences.ts:92,127`; `searchTemplates.ts:62,115`; `searchSnippets.ts:69,106`.

Every search tool has a client-side merge/wide-fallback branch that rebuilds the result as `{ data: …slice(0, limit), nextCursor: null }`, while `truncated` is computed as `… && nextCursor !== null`. With `nextCursor` forced to `null`, **`truncated` is structurally always `false` on that path** — even though the underlying fetch (100–200 rows) was itself capped and the slice dropped matches.
**Impact:** The agent receives a silently-truncated result with no signal that more matches exist and no cursor to page. Verified in all five tools (originally reported for `searchProspects` only; the gap-closure pass confirmed the identical pattern in the other four).
**Remediation:** On the fallback path, set `truncated` from the pre-slice size (e.g. `ranked.length > limit`); keep `nextCursor: null`. **Effort:** S (one shared idiom across five files).

#### COR-06 — `compareSequences` declares a winner with no signal; one bad id aborts all · Medium
**Location:** `compareSequences.ts:41-42,76-82`. `parsed.find(p => p.error)` short-circuits the whole comparison if **any** sequence errors (`notFound`/`tooLarge`), discarding the valid ones; and `pickWinner` seeds on `best === null`, so when all rates are `0` the first sequence is returned as winner at `rate: 0` (ties resolve silently by input order). **Remediation:** annotate/skip failed sequences instead of aborting; return `null`/`noData` when the best rate is 0; surface ties. **Effort:** S–M.

#### COR-07 — Single-page caps silently drop matches · Medium
**Location:** `_resolvers.ts:54` (accounts, 200), `:83` (users, 500), `:111` (stages, 500); `getTeamRoster.ts:15` (users, 500); `searchProspects.ts:241` (active-seq counts, 1000); similar in `getAccountProfile`/`getSequenceProfile`/`searchSequences`.

These single-page `client.list` calls filter client-side and ignore `nextCursor`. Consequences: a rep beyond row 500 resolves to `noResults` (so `searchProspects(ownerName=…)` returns nothing for a real person); and **`getTeamRoster` — whose entire output is the roster — silently caps at 500 users with no `truncated` flag**. None signal truncation. **Remediation:** use `paginate()` with a cap + `truncated`, or push the filter server-side. **Effort:** M.

#### COR-08 — No date validation or `from > to` guard · Medium · CWE-20
**Location:** `index.ts` zod schemas (`dateRangeFrom/To` are bare `j.string()`); `analyzeSequencePerformance`, `getUserActivity`, `getRecentMailings`, `getAuditLog`. Dates are interpolated into filters with no ISO validation and no ordering check: `from > to` → silent empty result; `"last week"` → malformed filter → confusing `outreachApiError`. **Remediation:** shared ISO + `from ≤ to` validator returning `validationError`. **Effort:** S.

#### COR-09 — Count pre-flight swallows all errors into `tooLarge` · Medium
**Location:** `analyzeSequencePerformance.ts:80-88` — `catch { return tooLarge(-1, true); }` maps `tokenInvalid`/`scopeMissing`/`rateLimited`/5xx all to "too large." `getRecentMailings.ts:43-48` does it correctly (only `outreachApiError` → `tooLarge`, else rethrow). **Remediation:** adopt that pattern; factor into a shared helper. **Effort:** S.

#### COR-10 — `getProspectSequenceHistory` can report negative duration · Low
`getProspectSequenceHistory.ts:46-49` computes `Math.round((endedMs - enrolled)/…)` with no `Math.max(0, …)`; clock skew / imported data with `stateChangedAt < createdAt` yields a negative `durationDays`. **Remediation:** clamp to `≥ 0` or `null`. **Effort:** S.

#### COR-11 — `coerceId` precision loss for IDs > 2^53 · Low
`jsonapi.ts:175-182` converts integer-form string IDs via `Number(id)`; values above `MAX_SAFE_INTEGER` lose precision. Latent today. **Remediation:** keep string form above the safe-integer bound. **Effort:** S.

#### COR-12 — `client.count` collapses the "couldn't count" case to `0` · Low
**Location:** `src/api/client.ts:181-184`. Returns `{ count: result.count ?? 0, truncated: result.countTruncated === true }`. Outreach signals an un-countable (throttled) result as `count: 0, count_truncated: true` (per `count.ts`'s own doc), so a caller that reads `count` before `truncated` sees a real "0." `getOpenTasks` returns `totalCount: totalCount.count` (→ 0) directly; `analyzeSequencePerformance`/`getRecentMailings` are safe because they check `truncated` first. **Remediation:** return a `-1` sentinel (the convention tools already use for "uncountable") when `truncated && count === 0`, or document the check-`truncated`-first contract. **Effort:** S.

### 5.2 Security

#### SEC-01 — Logger redacts by key only; secrets/PII in values reach stderr · High · Release blocker · CWE-532, CWE-359
**Location:** `src/logger.ts:90`; feeders at `src/api/client.ts:219,234` and `src/tools/_helpers.ts:69-95`.

```ts
out[key] = REDACT_KEYS.has(key) ? "[REDACTED]" : redact(value);   // only the KEY is inspected
```

String *values* are never scanned. Confirmed paths:
- **PII (readily triggered):** `runTool` logs `errorEnvelope: result`; `searchProspects` (and all search tools) return `noResults({ filters: input })` where `input.query` is matched against emails. Searching `jane@acme.com` and getting no result writes that email to `stderr` under key `query`/`filters`, which the key-based redactor ignores. The parallel `redact(input)` copy leaks it too.
- **Secrets (possible):** `exceptionToEnvelope` puts arbitrary `e.message` into `detail`/`message`; and `fetchDocument`/`fetchTypes` put up to 200 chars of the HTTP **response body** into the `outreachApiError` `detail` (`client.ts:219,234`). Any token-shaped or PII content in an upstream error body is logged verbatim.

**Exploitability:** No attacker action required for the PII path — ordinary use leaks PII to `stderr`, commonly shipped to a centralized/third-party log store. **Test blind spot:** `logger.test.ts` only asserts redaction of values *at sensitive keys*; it never tests a token in a value under a benign key — so the suite reports "redaction works" while this gap is uncaught.
**Remediation:** add a value-scrubbing pass over string leaves in `redact()` (`Bearer\s+\S+`, `(access_token|refresh_token|code|client_secret)=[^&\s]+`, JWT shape); for `noResults`/`validationError`, log only `errorEnvelope.error` plus the already-redacted input; add a test for a token-in-value. **Effort:** M.

#### SEC-02 — Logger over-redacts legitimate domain fields · Medium
**Location:** `src/logger.ts:71-75`. `REDACT_KEYS` includes bare `state`, `code`, `token`, `bearer`. `state` is pervasive Outreach data (`sequenceState`/task/mailing `state`); `code` is common. Any logged result/envelope has these clobbered to `[REDACTED]`, degrading the diagnostics §2.1 mandates. (`logger.test.ts:84-100` asserts these are redacted, so the fix must update that test.) **Remediation:** redact OAuth-specific values via SEC-01's scrubber or qualified keys; drop the bare generic entries (`state`/`token`/`bearer` are not in §2.2's required list). **Effort:** S.

#### SEC-03 — Token-permission `fstat` verification (§2.3) not implemented · High
**Location:** `src/auth/tokenCache.ts:58-87` (`grep` confirms no `fstat`/`fchmod`/`stat` in `src`).

§2.3 and `SECURITY.md` state the `0600`/`0700` permissions are "Verified by a post-write `fstat` check." The code performs best-effort `fs.chmod` only (line 86), with a comment acknowledging "overlay FS quirks," and never reads the mode back. **Test gives false comfort:** `tokenCache.test.ts:56-68` checks permissions via a post-hoc path `fs.stat` on the developer's tmpfs (which honors mode bits); it would not catch a production filesystem that silently ignores them — precisely the case the documented `fstat` control exists to fail loudly on.
**Impact:** On such a filesystem, or if the file pre-exists with looser perms, a long-lived refresh token can land world-readable and the code reports success. Rated High (long-lived credential + a security control the project asserts it has but doesn't). **Remediation:** after write, stat the handle/path and throw if `(mode & 0o777) !== 0o600`; add a test that forces a mismatch. **Effort:** S.

#### SEC-04 — Token cache: symlink-follow / TOCTOU; intermediate-directory permissions · Low · CWE-367/59/377
**Location:** `tokenCache.ts:59-86`. Predictable temp name (`${path}.${pid}.tmp`) opened `"w"` (follows symlinks); post-rename `fs.chmod(this.path, …)` also follows symlinks; `mkdir(…, {mode:0o700})` applies the mode only to created dirs and the re-chmod covers only the leaf, so intermediate components of a deep custom path can be left at umask. **Exploitability:** requires a local attacker with write access to the 0700 directory — largely out of the documented threat model. **Remediation:** `O_CREAT|O_EXCL|O_NOFOLLOW` + random suffix; `fchmod` the fd; chmod each created component. **Effort:** S–M.

#### SEC-05 — stdout-pollution control (§2.1) absent in CI and tests · Medium
**Location:** `.github/workflows/ci.yml`; `tests/unit/logger.test.ts:33-41`. §2.1 claims "CI test enforces this with a stdout-pollution check." No such CI step exists, and the logger test only checks that the four `logger.*` functions write to `stderr` — it never boots the server to assert the *process* emits only MCP frames. A stray `stdout` write in any imported/transitive module silently corrupts the transport. **Remediation:** subprocess/integration test asserting every `stdout` line is a JSON-RPC frame; wire into CI. **Effort:** M.

#### SEC-06 — `redact()` has no circular-reference guard · Low · CWE-674
`logger.ts:82-93` recurses with no visited set; a cyclic input (or an `Error` with circular `cause`) overflows the stack on the logging path. **Remediation:** thread a `WeakSet`; return `"[Circular]"`; wrap `emit()`'s `JSON.stringify`. **Effort:** S.

#### SEC-07 — Bootstrap hardening · Low/Info · CWE-208/209
**Location:** `bootstrap.ts:81`; `bootstrap-oauth.ts:105,141`. State compared with `!==` (CWE-208) — **not practically exploitable** (ephemeral per-flow nonce, no oracle); the loopback handler never checks `req.method`; `TokenExchangeError` echoes ≤200 chars of the provider body (CWE-209). The callback HTML page is correctly escaped (no reflected XSS). PKCE/state generation and `parseCallback` are well-tested. **Remediation:** `crypto.timingSafeEqual` (or document the exception), `405` for non-GET, drop the body echo. **Effort:** S.

### 5.3 Availability & resilience

#### AVL-01 — Unbounded sleep on `Retry-After` / rate-limit reset · High · Release blocker · CWE-400
`client.ts:249,266` pass server-controlled seconds straight to `sleep()` uncapped; `parseRetryAfter` accepts any finite `n ≥ 0` (`Retry-After: 86400` → 24h), and `recommendDelaySeconds` returns an unbounded `secsUntilReset` when `remaining ≤ 0`. Blocks the single-threaded server with no cancellation (compounded by AVL-02). **Remediation:** clamp both (e.g. ≤ 60s); above the cap, return `rateLimited(wait)` immediately. **Effort:** S.

#### AVL-02 — No request timeout on API `fetch` · High · Release blocker · CWE-1088
`client.ts:298-306` issues `fetch` with no `AbortController`. A stalled connection hangs the server indefinitely. The auth layer already does this correctly (`oauth.ts:124-141`), and an unused `timeout()` envelope exists. **Remediation:** `AbortSignal.timeout(ms)` per fetch; throw `timeout()` on abort. **Effort:** S.

#### AVL-03 — `Promise.all` collapses the tool on one sub-fetch failure · High · Release blocker
`getProspectProfile.ts:30` and `draftEmail.ts:29` compose parallel calls with `Promise.all`; one `scopeMissing`/timeout/5xx rejects the whole tool. `getSequenceProfile.ts:36,68-148` already models the correct `unavailableSections` degradation (though its own final `allStates` fetch at `:150` is unwrapped). **Remediation:** keep the core `get` hard; wrap optional sections to degrade to empty data + `unavailableSections`. Apply to `getAccountProfile`'s list fetches and the `getSequenceProfile` tail too. **Effort:** M.

#### AVL-04 — OAuth couples request success to cache-write success (untested) · Medium
`oauth.ts:164-179` awaits `cache.write` **before** setting/returning the in-memory token; a write failure (disk full, EPERM, the SEC-03/04 conditions, read-only FS) fails `getAccessToken()` and every coalesced caller, despite a valid token in hand — contradicting the module's "cache is an optimization" framing. The `oauth.test.ts` suite uses `InMemoryTokenCache`, so this failure path is **untested**. **Remediation:** set the in-memory token and return first; wrap persistence in try/catch that logs and continues (or document durable-or-fail intent). **Effort:** S.

#### AVL-05 — `recommendDelaySeconds` NaN when `limit === 0` · Low
`rateLimit.ts:50` — `X-RateLimit-Limit: 0` makes `pctRemaining = NaN`; `NaN > 10` is false, so with `remaining ≤ 0` it returns the unbounded `secsUntilReset` (compounds AVL-01). **Remediation:** guard `if (!Number.isFinite(limit) || limit <= 0) return 0`. **Effort:** S.

### 5.4 Process & build

#### PRC-01 — Repository fails its own lint gate; CI red on `main` · High · Release blocker
`src/api/client.ts:32-39` — three `import/order` errors. `npm run lint` exits 1; `ci.yml` runs it, so CI on `main` would fail and `npm run verify` is not clean as cloned. §6.1 ("CI must be green to merge") is not holding. **Remediation:** `npm run lint:fix`; investigate why `main` merged red (branch-protection config). **Effort:** XS.

#### PRC-02 — `npm run smoke:live` references a missing script · Low
`package.json` → `tsx … scripts/smoke-live.ts`; `scripts/` contains only `bootstrap-oauth.ts`. §4.4 cites this path. **Remediation:** add the script or remove the entry + §4.4 reference. **Effort:** XS.

### 5.5 Design & maintainability

#### DES-01 — Dead modules; pagination drop-last-page bug · Medium
`src/api/count.ts` (`classifyCount`) and `src/api/pagination.ts` (`paginate`) have **zero importers** (grep) — tools hand-roll count classification and page loops — yet both are unit-tested (false confidence). `paginate.ts:74-84` additionally drops the remainder of the final page when `maxRecords` lands mid-page while reporting `truncated: false`. **Remediation:** adopt as the single source of truth (the clean fix for COR-05/COR-07/COR-12 too) or delete per §7.3; if kept, set `truncated` on the mid-page break. **Effort:** M.

#### DES-04 — `draftEmail` returns untruncated template bodies · Medium
`draftEmail.ts:173-174` returns full `bodyHtml`/`bodyText`; `getTemplate`/`getSnippet` cap at 5000. Context-budget risk and inconsistent. **Remediation:** apply the shared truncation. **Effort:** S.

#### DES-02 — Duplicated helpers · Low
`clamp`, `nameFromParts`, `isNonEmpty` are copy-pasted across ~10 tool files; two `nameFromParts` variants diverge (`draftEmail`/`getProspectSequenceHistory` return `string`, others `string | undefined`). **Remediation:** consolidate into `_helpers.ts`. **Effort:** S.

#### DES-03 — `as` casts without §1.4 justification · Low
~35 `row["x"] as number`/`as string` reads, the `registerTool`/`args` casts in `index.ts:57-76`, and the whole-document cast in `client.ts:236` (+ `meta.count` trusted unvalidated). Some are unsound (`accountId as number` when absent → `undefined` in a URL/Map key). **Remediation:** narrow via typed accessors; add the required justifications where casts are legitimate. **Effort:** M.

#### DES-05 — Informational nits
- `ambiguousMatch` builds `${noun}es` → "companyes"/"owneres" (`envelopes.ts:136`); `errors.test.ts` uses the default noun, masking it.
- Body truncation (`getTemplate`/`getSnippet`) can split a UTF-16 surrogate pair.
- `getOpenTasks` uses a magic `"0001-01-01"` lower bound; `searchAccounts` uses `Number.MAX_SAFE_INTEGER` — both instead of the documented `"neginf"`/`"inf"` sentinels.
- Two divergent pluralization maps (`_helpers.ts URL_PATH_PLURALS` vs `client.ts IRREGULAR_PLURALS`).
- The allowlist (27 resources) is **broader** than the granted scopes (19); `allowlist.ts`'s "mirrors the OAuth read scopes" comment is inaccurate (harmless — upstream 403→`scopeMissing` handles the rest).
- `extractMissingScope` loose fallback regex (`client.ts:350`) can mint a wrong scope name from arbitrary 403 prose.
- Dead `undefined` placeholder fields (`stageId`, `currentStepNumber`, `accountName`, `mailboxOwnerName`); `getOpenTasks` even fetches `prospect.account` but never flattens/returns `accountName`.
- `analyzeSequencePerformance` advertises `groupBy: "rep"` but always returns empty groups; unknown `groupBy` silently no-ops — make it a `z.enum`.
- Read-only invariant is enforced by a hardcoded `method: "GET"` literal, not the "method allowlist" §2.7 describes.

### 5.6 Testing

#### TST-01 — Tool blocks B, C, E untested (12/19 capability tools) · High
`tests/tools/` has only `blockA`, `blockD`, `escapeHatches`. Untested: `searchSequences`, `getSequenceProfile`, `getProspectSequenceHistory`, `analyzeSequencePerformance`, `compareSequences`, `searchTemplates`, `getTemplate`, `searchSnippets`, `getSnippet`, `getRecentMailings`, `getUserActivity`, `draftEmail`. The §4.1 `tools/` threshold exemption is justified *by* these block tests, so it protects nothing for the untested blocks; `draftEmail`'s "never sends" promise and the `tooLarge` pre-flight are unverified. **Remediation:** add `blockB`/`blockC`/`blockE` tests (Block E asserting a context-only bundle; analyze asserting `tooLarge` fires and `list` is not called). **Effort:** M–L.

#### TST-04 — Stub discards filters; two tests encode bugs as correct · High
`tests/fixtures/stubOutreachClient.ts:34-36` returns seeded rows and **ignores `options`/filters** (and `count` always returns `truncated: false`). Tools read uninjected `new Date()`. So tests assert response shape but never the filters sent — directly why COR-01/02/04 went uncaught. Two tests assert the buggy behavior as correct: `blockD.test.ts:75-90` (COR-01) and `blockA.test.ts:184-194` (COR-02). The stub already records `listCalls`/`countCalls`, but no test inspects them. **Remediation:** inject a clock; assert `client.listCalls`/`countCalls` contain the expected scoped filters; update the two encoding tests as part of the COR-01/02 fixes. **Effort:** M.

#### TST-02 — Name-resolver lookups untested · Medium
`blockA.test.ts:47` calls `searchProspects({ query: "Sally" })` only — the `companyName`/`ownerName`/`stage` resolver branches (`_resolvers.ts`) and the `ambiguousMatch`/`noResults` outcomes are never exercised. A wrong-account-ID resolution (returning another customer's prospects) would not be caught. **Remediation:** seed multiple/zero/one match; assert outcomes and the resolved filter. **Effort:** M.

#### TST-03 — OAuth loopback callback server untested · Medium
`bootstrap.test.ts` covers the pure helpers and the mock-fetch exchange; no test starts the loopback server (`grep createServer|listen` → none). The CSRF check is tested as a pure function, but the server wiring, 404/400 branches, timeout, and `server.close()` are not (contra §4.3). **Remediation:** drive `awaitCallback` against a real loopback request (good/bad/missing state) on an ephemeral port. **Effort:** M.

#### TST-05 — Deny-by-default allowlist not directly tested · Medium
`escapeHatches.test.ts:22,72` exercises the allowlist only via two nonsense strings + one allowed resource; `isAllowedResource`/the 27-entry set have no direct test asserting the full allowed set and rejecting representative write/disallowed resources. (Malformed-JSON handling *is* tested — good.) **Remediation:** direct unit test of the allowlist. **Effort:** S.

---

## 6. Standards-conformance matrix (`STANDARDS.md`)

| § | Requirement | Status | Evidence / finding |
|---|---|---|---|
| 1.1 | Strict TS flags (7 named) | ✅ Pass | All 7 verified in `tsconfig.json`; `tsc` clean |
| 1.2–1.4 | No `any` / non-null / unjustified `as` | ⚠️ Partial | No `any`/non-null in prod; `as` casts lack §1.4 justification (DES-03) |
| 1.5 | Named exports only | ✅ Pass | `import/no-default-export` green |
| 1.6 | `readonly` by default | ✅ Pass | Consistent |
| 1.7 | Result-typed envelopes | ✅ Pass | Discriminated union + factories; all 14 tested |
| 1.8 | No floating promises | ✅ Pass | Rule enabled & green |
| 1.9 | No `console.*` in prod | ✅ Pass | Relaxed only in `scripts/`,`tests/` |
| 2.1 | Stdout sacred + CI stdout check | ⚠️ Partial | Code respects it; the claimed CI/test check is absent (SEC-05) |
| 2.2 | Tokens/PII never logged | ❌ Fail | Key-only redaction; values leak (SEC-01); over-redaction (SEC-02) |
| 2.3 | Tokens at rest 0600/0700, fstat-verified | ❌ Fail | `fstat` verification absent (SEC-03) |
| 2.4 | OAuth PKCE S256 + state, verified | ✅ Pass | Verified in code + tests; (non-constant-time compare — SEC-07, info) |
| 2.5 | All env reads via `config/` | ✅ Pass | Validates & throws naming the variable |
| 2.6 | Boundary validation; allowlist deny-by-default | ⚠️ Partial | Allowlist correct but untested (TST-05); zod lacks numeric/date refinement (COR-08) |
| 2.7 | Read-only via method allowlist | ⚠️ Partial | Read-only holds; enforced by hardcoded literal, not an allowlist (DES-05) |
| 2.8 | No dynamic code execution | ✅ Pass | None found; lint bans present |
| 2.9 | Dependencies pinned | ✅ Pass | Zero `^`/`~` |
| 2.10 | No unreviewed postinstall | ✅ Pass | `npm ci --ignore-scripts` in CI |
| 3.1–3.5 | Architecture / no cycles / no module-level mutable state | ⚠️ Partial | `import/no-cycle` green; sanctioned singletons OK; **dead modules** (DES-01) |
| 4.1 | Coverage thresholds (measured layers) | ✅ Pass | 92/88/94/96 vs 85/80/85/85 (`logger.ts` absent from report — DES-05) |
| 4.2 | Every public fn / block tested | ❌ Fail | Blocks B/C/E (TST-01); resolvers (TST-02); allowlist (TST-05) |
| 4.3 | OAuth flow incl. in-process server tested | ❌ Fail | Loopback server untested (TST-03) |
| 4.4 | No live calls in `npm test` | ✅ Pass | Confirmed (`smoke:live` script missing — PRC-02) |
| 4.5 | Deterministic / injected clock | ⚠️ Partial | Primitives inject clock; tools read `new Date()` (TST-04) |
| 4.6 | One behavior per test | ✅ Pass | Observed |
| 5.1–5.4 | Prettier / ESLint / comments / JSDoc | ⚠️ Partial | Format green; **lint fails** (PRC-01); comments good |
| 6.1 | CI green to merge | ❌ Fail | CI would be red (PRC-01) |
| 6.2–6.4 | Reproducible build / no network / SemVer | ✅ Pass | `tsc`-only; `npm ci` reproducible |
| 7.1–7.3 | Change discipline / no speculation | ⚠️ Partial | Dead modules + dead placeholder fields (DES-01, DES-05) |

---

## 7. Pipeline execution results (commit `651ca6a`, clean `npm ci`)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run check` | ✅ exit 0 |
| Lint | `npm run lint` | ❌ exit 1 — 3 `import/order` errors (PRC-01) |
| Format | `npm run format:check` | ✅ exit 0 |
| Tests | `npm run test` | ✅ 197 passed / 19 files |
| Coverage | `npm run test:coverage` | ✅ stmts 92.2% · branch 87.7% · func 93.7% · lines 95.7% (measured layers; thresholds 85/80/85/85) |
| Build | `npm run build` | ✅ exit 0 |

---

## 8. Positive assurances (verified safe)

- **OAuth2 correctness:** PKCE S256 (64-byte verifier), `state` generated + verified with rejection, loopback bound to `127.0.0.1`, refresh-token rotation persists the new token, concurrent refreshes coalesce to one exchange, in-flight slot released on failure, 30s timeout on the refresh exchange. Confirmed in both `oauth.ts`/`bootstrap.ts` and `oauth.test.ts`/`bootstrap.test.ts`.
- **Read-only invariant:** `method: "GET"` is the only method emitted; no mutation path exists; `draftEmail` confirmed read-only with a no-send reminder.
- **Injection / SSRF / prototype pollution:** filter keys/values URL-encoded via `URLSearchParams`; `JSON.parse` of `filters`/`fields` yields own-properties only; `links.next` is parsed only to extract the opaque `page[after]` cursor, never fetched.
- **Escape-hatch allowlist:** deny-by-default `Set.has` before any call; no write-capable resource in the set; malformed-JSON inputs rejected with `validationError`.
- **Config:** required vars validated at startup; errors name the variable without echoing its value; `OUTREACH_API_BASE` forced https.
- **Schema cache:** concurrency-safe single-flight load with a `failed` latch; sanctioned singleton with a reset seam.
- **Type system & supply chain:** all 7 strict flags on; all claimed ESLint rules present; dependencies fully pinned; `npm ci --ignore-scripts` in CI; all 14 error-envelope factories unit-tested.
- **Callback page:** HTML-escaped (no reflected XSS).

---

## 9. Verification scope, assumptions & limitations

- **Static review only.** No code was executed against a live Outreach tenant; claims about Outreach API behavior (e.g. whether a resource supports an `account` filter, whether bounced mail can carry `openedAt`) rest on documented JSON:API conventions and the code's own comments. Items contingent on live behavior say so inline.
- **Threat model.** Token-cache confidentiality findings (SEC-04) are assessed against `SECURITY.md`'s model, which places full local compromise out of scope.
- **Read first-hand (the basis for "Verified"):** the **entire `src/` tree** — `index.ts`, `config/index.ts`, `logger.ts`, `errors/envelopes.ts`, `schema/customFields.ts`; all of `auth/` (`oauth`, `tokenCache`, `bootstrap`, `index`, `scopes`); all of `api/` (`client` in full, `filters`, `jsonapi`, `rateLimit`, `count`, `pagination`); all of `tools/` (`_helpers`, `_resolvers`, `allowlist`, and all 21 tool files); `scripts/bootstrap-oauth.ts`; all build/config files; `ci.yml`. **Tests read first-hand:** `fixtures/stubOutreachClient.ts`, `fixtures/toolHarness.ts`, `tools/{blockA,blockD,escapeHatches}.test.ts`, `unit/logger.test.ts`, `unit/errors.test.ts`, `unit/auth/{oauth,bootstrap,tokenCache}.test.ts`. Plus the full pipeline run.
- **Residual (confirmed via execution + coverage, not line-by-line):** the primitive-layer unit tests `unit/api/{client,count,filters,jsonapi,pagination,rateLimit}.test.ts`, `unit/auth/{scopes,authIndex,invalidate}.test.ts`, `unit/config.test.ts`, `unit/schema/customFields.test.ts`, and `fixtures/inMemoryTokenCache.ts`. Their substance is corroborated by the 197-passing run and the per-file coverage numbers; no finding depends on their internal content (the test findings concern what is *absent*).
- **Corrected reviewer error.** One subsystem reviewer reported "no CI / no `.github/workflows`" as Critical; this was **false** (wrong working directory). `.github/workflows/ci.yml` and `dependabot.yml` exist at the repo root; CI runs the Node 20/22 matrix. The narrower true claim (no stdout-pollution check) is retained as SEC-05.

---

## 10. Remediation roadmap

**Phase 0 — Unblock CI (hours)**
- PRC-01 `npm run lint:fix`; confirm branch protection requires the lint check.

**Phase 1 — Release blockers (2–4 eng-days + tests)**
- COR-01..04 — fix the four data-integrity defects as one pass (scope filters to entity + time; gate rate numerators on delivery). **Update the two tests that currently encode the bugs** (`blockD.test.ts:75`, `blockA.test.ts:184`) to assert the scoped filters via `client.listCalls`/`countCalls`.
- SEC-01 — value-scrubbing redaction (+ SEC-02/SEC-06, same module) and a token-in-value test.
- AVL-01/02 — clamp sleeps; add fetch timeout.
- AVL-03 — `unavailableSections` degradation for `getProspectProfile`/`draftEmail` (+ `getAccountProfile`, `getSequenceProfile` tail).
- TST-01/TST-04 — block B/C/E integration tests that assert outgoing filters; inject a clock.

**Phase 2 — Close documented-control gaps (1–2 eng-days)**
- SEC-03 implement + test the `fstat` check; SEC-05 add the stdout-pollution test; PRC-02 fix/remove `smoke:live`.
- DES-01 adopt-or-delete the dead modules (folds in COR-05/COR-07/COR-12); COR-08 shared date validator; COR-09 correct error mapping.
- TST-02/03/05 resolver, OAuth-server, and allowlist tests.

**Phase 3 — Hardening & polish (opportunistic)**
- AVL-04/05, COR-06/10/11/12, SEC-04/07, DES-02/03/04/05.

---

*End of review. Finding IDs are stable; reference them in remediation PRs (e.g., "Fixes COR-01, COR-04").*
