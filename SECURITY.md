# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in `outreach-api-mcp`, please report it privately. **Do not file a public GitHub issue.**

Email: `joefisherpersonal@gmail.com` (PGP key available on request).

We aim to acknowledge within 72 hours and provide a remediation plan within 14 days for high-severity issues.

## Supported versions

Only the `main` branch is supported. There are no LTS branches.

## Threat model

The MCP server runs as a local subprocess of an MCP client (Claude Desktop, an IDE, etc.) on the user's own machine. It holds long-lived OAuth credentials for a single Outreach workspace and acts as that user's read-only proxy to the Outreach v2 REST API.

### In scope

- **Credential exfiltration via logs.** The server must never write OAuth tokens, refresh tokens, client secrets, or `Authorization` headers to any sink. Stderr logs are structured JSON with explicit redaction of known sensitive keys.
- **Credential exfiltration via MCP responses.** Tool responses must contain only the data the agent requested. The server must not echo credentials, environment variables, or filesystem paths beyond what tools' documented contracts require.
- **MCP stdio protocol safety.** Stdout is reserved exclusively for MCP JSON-RPC frames. Any spurious write to stdout corrupts the transport. All logging, errors, and diagnostics go to stderr.
- **Token-at-rest protection.** On-disk token cache is written with `0600` permissions in `$XDG_CONFIG_HOME/outreach-api-mcp/`. Parent directory is created with `0700` perms.
- **OAuth bootstrap CSRF.** The bootstrap flow uses a cryptographically random `state` parameter and rejects callbacks with mismatched state. PKCE (`S256`) is used so the client secret never enters the browser URL.
- **Read-only invariant.** No tool issues `POST`, `PATCH`, or `DELETE`. Only `.read` scopes are requested. Tool implementations must not call HTTP methods other than `GET`.
- **Dependency hygiene.** `npm audit` runs in CI; high/critical findings fail the build. Dependencies are pinned (no `^` or `~`) and Renovate / Dependabot manages updates.
- **Input validation.** Every tool input is validated by a zod schema at the registration boundary before the implementation runs. The `outreachQuery` escape hatch validates `resource` against a hardcoded allowlist.

### Out of scope

- **Compromise of the user's machine.** If the user's machine is compromised, the token cache is reachable; no host-level hardening is attempted beyond filesystem permissions.
- **Compromise of Outreach itself.** Upstream API behavior is trusted.
- **Side-channel attacks against the MCP client.** The client process is assumed honest; if it requests data, we return it.
- **Denial of service.** Rate-limit handling is best-effort; we honor `Retry-After` and back off but make no anti-DoS guarantees.

## Hardening choices

- **No telemetry.** The server makes no outbound calls beyond Outreach API endpoints.
- **No postinstall scripts.** Dependencies that ship `postinstall` are reviewed manually; we prefer alternatives without them.
- **Strict TypeScript.** `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Untyped `any` is a lint error.
- **No `eval`, no dynamic `Function()`, no dynamic `require`.** Forbidden by lint rules.
- **PII redaction in logs.** Emails, names, message bodies, phone numbers are redacted automatically by the structured logger.

## Cryptography

- PKCE verifier: 64 bytes from `crypto.randomBytes`, base64url-encoded
- PKCE challenge: `S256` of the verifier
- OAuth `state`: 32 bytes from `crypto.randomBytes`, base64url-encoded
- Token cache file permissions: `0600` (owner read/write only)
- Token cache parent directory permissions: `0700` (owner only)
- Post-write fstat verification: after the atomic rename, the file is re-opened read-only and `stat()` confirms `(mode & 0o777) === 0o600`. A mismatch throws `TokenCachePermissionError` rather than leaving credentials at unsafe permissions — see `tokenCache.ts` SEC-03 path.
