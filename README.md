# Outreach API MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Outreach](https://www.outreach.io). You give it your own Outreach OAuth credentials, an MCP client like Claude Desktop talks to it over stdio, and you get 21 read-only tools for querying prospects, accounts, sequences, templates, snippets, tasks, mailings, and audit logs from your own workspace.

Independent integration. Not affiliated with, endorsed by, or sponsored by Outreach. You comply with Outreach's API terms; this code just speaks the protocol.

## Status

v0.1.2. The MCP server is in `outreach-worker/` and runs over stdio. Read-only by design: no POST, PATCH, or DELETE, and no write scopes get requested. CI runs on Node 20 and Node 22 against 290 unit and integration tests. Three review passes have landed: the initial scaffold review, the v0.1.1 blocker-fix verification, and the v0.1.2 fast-follows (correctness, security hardening, test coverage, and design cleanup — see commit history on `main` for the per-finding trail).

## Prerequisites

Two things:

1. Node.js, version 20 or newer.
2. An Outreach OAuth application in your own Outreach workspace. You register this once and reuse it forever.

## Registering an Outreach OAuth app

You do this once per workspace. The server uses these credentials to mint per-user refresh tokens, and credentials never get shared across users of your workspace.

The steps:

1. Sign in to Outreach as a user with admin permission for API integrations.
2. Open Settings (gear icon), then Integrations, then API Access, then "Your applications."
3. Click the button to create a new app.
4. Fill in the form:
   * Name: anything descriptive, like `outreach-api-mcp (local)`.
   * Description: optional.
   * Redirect URIs: add `http://127.0.0.1:8765/callback`. If you later change the port via `OUTREACH_OAUTH_REDIRECT_PORT`, the URI here has to match exactly.
   * Scopes: pick every scope listed in [`outreach-worker/src/auth/scopes.ts`](./outreach-worker/src/auth/scopes.ts). All of them end in `.read`. If you grant fewer, the tools that need a missing one will return a `scopeMissing` envelope and the agent will tell you which.
5. Save the app.
6. Copy the Application ID into `OUTREACH_CLIENT_ID` and the Application Secret into `OUTREACH_CLIENT_SECRET`. Outreach will not show the secret again, so put it somewhere safe.

A couple of gotchas. If the API Access page is hidden in your UI, an admin needs to grant you "Manage API Integrations" first. And the redirect URI has to match exactly, down to scheme, host, and port. `http://127.0.0.1` (not `localhost`) is the right value; Outreach accepts it as loopback per [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252).

## Install

Two paths. Pick whichever feels more natural.

**From a tagged release tarball** (no clone required; treats this like a normal npm dependency):

```bash
npm install -g https://github.com/joethefisher/outreach-api-mcp/releases/download/v0.1.2/outreach-api-mcp-0.1.2.tgz
```

That gives you the `outreach-api-mcp` binary on your PATH plus the bundled `dist/`. Skip ahead to the [bootstrap](#bootstrap) section.

**From source** (if you want to read the code, contribute, or run on an unreleased commit):

```bash
git clone https://github.com/joethefisher/outreach-api-mcp.git
cd outreach-api-mcp/outreach-worker
npm ci
npm run build
```

## Bootstrap

```bash
# Put your app credentials in ../.env first (the bootstrap script reads it).
cp ../.env.example ../.env  # then edit OUTREACH_CLIENT_ID / SECRET

# One-time browser consent flow. Captures the refresh token.
npm run bootstrap:oauth
```

What `bootstrap:oauth` does, in order: opens your browser, walks you through the Outreach consent screen, captures the redirect on a local loopback HTTP server, exchanges the code for a refresh token, persists it to the on-disk cache, and prints an `.env` block on success. Copy that block into your `.env` (or wherever your MCP client sources env from). That is the whole setup.

### Wiring into an MCP client

Once you have all three credentials, point your MCP client at the built server. The bootstrap step is only needed once; from this point on the credentials live in your MCP client's config and the on-disk token cache.

For Claude Desktop, find `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and add an entry:

```json
{
  "mcpServers": {
    "outreach": {
      "command": "node",
      "args": ["/absolute/path/to/outreach-api-mcp/outreach-worker/dist/index.js"],
      "env": {
        "OUTREACH_CLIENT_ID": "...",
        "OUTREACH_CLIENT_SECRET": "...",
        "OUTREACH_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

Fully quit and reopen Claude Desktop (a window reload is not enough — the MCP transport only restarts on app launch). The 21 tools below will show up in the tool picker. The server reads its configuration from the env you provide in this config block, not from any `.env` file on disk.

For other MCP clients, the contract is the same: spawn `node dist/index.js` as a subprocess with the three env vars set, and talk to it over stdio.

## Configuration

Everything is environment variables. [`.env.example`](./.env.example) has the full list. The minimum:

| Variable | Purpose |
|---|---|
| `OUTREACH_CLIENT_ID` | OAuth client ID from your app |
| `OUTREACH_CLIENT_SECRET` | OAuth client secret from your app |
| `OUTREACH_REFRESH_TOKEN` | Long-lived refresh token from `bootstrap:oauth`. Seeds the on-disk cache on first run; after that the cache is the source of truth. |

## Available MCP tools

21 tools across five categories: 19 capability tools and 2 escape hatches. Schemas are in [`outreach-worker/src/index.ts`](./outreach-worker/src/index.ts) if you want to read them directly.

| Category | Tools |
|---|---|
| Prospects and Accounts | `searchProspects`, `getProspectProfile`, `searchAccounts`, `getAccountProfile` |
| Sequences | `searchSequences`, `getSequenceProfile`, `getProspectSequenceHistory`, `analyzeSequencePerformance`, `compareSequences` |
| Templates and Snippets | `searchTemplates`, `getTemplate`, `searchSnippets`, `getSnippet` |
| Activity and Audit | `getOpenTasks`, `getRecentMailings`, `getTeamRoster`, `getUserActivity`, `getAuditLog` |
| Drafting | `draftEmail` (returns a context bundle; never sends mail) |
| Escape hatches | `outreachQuery`, `outreachGetById` |

## Read-only invariant

The part I want to be very explicit about. The server is read-only. No POST, no PATCH, no DELETE. The HTTP client hardcodes `GET` on every call, and there is no path through any tool that mutates Outreach state. Only `.read` OAuth scopes are requested. Even `draftEmail` only returns context; the model composes the email in chat for you to paste into Outreach yourself.

If you find a tool that violates this, that is a bug. Open an issue.

## Security model

[SECURITY.md](./SECURITY.md) has the full threat model. Briefly:

* No telemetry. No outbound network calls beyond Outreach API endpoints.
* All logging goes to stderr only. Stdout is reserved for MCP JSON-RPC frames, and mixing them up would corrupt the transport, which is why it is enforced by lint and asserted in tests.
* OAuth tokens live in an on-disk cache with `0600` permissions, in `$XDG_CONFIG_HOME/outreach-api-mcp/`. The parent directory is `0700`.
* Refresh tokens rotate; the latest one always gets written back to cache.
* Tokens, PII, and message bodies are never logged. The structured logger redacts on the way out.
* Scope minimization: only the 19 read scopes that the tools actually need.

## Standards

This codebase commits to a quality bar in [STANDARDS.md](./STANDARDS.md). PRs get reviewed against it. The short version is strict TypeScript everywhere, integration tests for tool blocks, and no features the task did not request.

## License

[Apache 2.0](./LICENSE).
