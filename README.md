# Outreach API MCP

Public-safe [Model Context Protocol](https://modelcontextprotocol.io) server for querying [Outreach](https://www.outreach.io) sales engagement data — prospects, accounts, sequences, templates, snippets, tasks, mailings, audit logs — from your own Outreach workspace.

This project is an independent integration and is **not affiliated with, endorsed by, or sponsored by Outreach**. Users are responsible for complying with Outreach's API terms and for using their own OAuth credentials and workspace data.

## Status

The MCP server in [`outreach-worker`](./outreach-worker) runs over stdio against the Outreach v2 REST API. Read-only by design (no write scopes requested or used).

## Prerequisites

1. **Node.js ≥ 20**
2. **An Outreach OAuth application** registered in your own Outreach workspace (see the next section).

## Registering an Outreach OAuth app

You only do this once per workspace. The MCP server uses your app's client credentials to mint per-user refresh tokens; you don't share credentials across users of your workspace.

1. Sign in to Outreach as a user with admin permission to manage API integrations.
2. Open **Settings** (gear icon) → **Integrations** → **API Access** → **Your applications**.
3. Click **Create New App** (or the equivalent button — Outreach's UI evolves).
4. Fill in:
   - **Name**: anything descriptive, e.g. `outreach-api-mcp (local)`.
   - **Description**: optional.
   - **Redirect URIs**: add `http://127.0.0.1:8765/callback`. If you change the port (`OUTREACH_OAUTH_REDIRECT_PORT` in `.env`), the URI must match.
   - **Scopes**: select every scope listed in [`outreach-worker/src/auth/scopes.ts`](./outreach-worker/src/auth/scopes.ts). All are `*.read`. Outreach's UI groups scopes by resource — pick each one referenced in that file. Granting fewer scopes will surface `scopeMissing` envelopes for tools that need them.
5. Save the app.
6. From the app's detail page, copy the **Application ID** (= `OUTREACH_CLIENT_ID`) and **Application Secret** (= `OUTREACH_CLIENT_SECRET`). Store the secret somewhere safe; Outreach won't show it again.

If your Outreach UI doesn't expose API Access yourself, an admin needs to grant you `Manage API Integrations` first. The redirect URI must be exact (scheme, host, port, path), and `http://127.0.0.1` is acceptable to Outreach as a loopback per [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252).

## Quick start

```bash
git clone https://github.com/joethefisher/outreach-api-mcp.git
cd outreach-api-mcp/outreach-worker
npm ci
npm run build

# Put your app credentials in ../.env (next to this directory's parent).
# .env.example shows the full set of optional config too.
cp ../.env.example ../.env  # then edit OUTREACH_CLIENT_ID / SECRET

# One-time consent flow — opens your browser, captures the refresh token.
npm run bootstrap:oauth

# bootstrap:oauth prints an .env block on success — copy the values it shows
# into ../.env (or whatever env your MCP client sources from).
```

### Wiring into an MCP client

Once `bootstrap:oauth` has succeeded and `.env` holds all three credentials, point your MCP client at the built server. For example, in Claude Desktop's `claude_desktop_config.json`:

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

Restart your MCP client. The 21 tools listed below will appear; the server reads its config from the env you provide.

## Configuration

All configuration is via environment variables. See [`.env.example`](./.env.example) for the full list. The required minimum is:

| Variable | Purpose |
|---|---|
| `OUTREACH_CLIENT_ID` | OAuth client ID from your Outreach app |
| `OUTREACH_CLIENT_SECRET` | OAuth client secret from your Outreach app |
| `OUTREACH_REFRESH_TOKEN` | Long-lived refresh token from `bootstrap:oauth` (seeds the on-disk cache) |

## Available MCP tools

21 tools across five blocks (19 capability tools + 2 escape hatches). See [`outreach-worker/src/index.ts`](./outreach-worker/src/index.ts) for full registrations.

| Block | Tools |
|---|---|
| Prospects & Accounts | `searchProspects`, `getProspectProfile`, `searchAccounts`, `getAccountProfile` |
| Sequences | `searchSequences`, `getSequenceProfile`, `getProspectSequenceHistory`, `analyzeSequencePerformance`, `compareSequences` |
| Templates & Snippets | `searchTemplates`, `getTemplate`, `searchSnippets`, `getSnippet` |
| Activity & Audit | `getOpenTasks`, `getRecentMailings`, `getTeamRoster`, `getUserActivity`, `getAuditLog` |
| Drafting | `draftEmail` (context bundle only — never sends mail) |
| Escape hatches | `outreachQuery`, `outreachGetById` |

## Read-only invariant

This server is **read-only**. No `POST`, `PATCH`, or `DELETE` is issued by any tool. Only `.read` OAuth scopes are requested. `draftEmail` returns context for an LLM to compose with — it never sends mail.

## Security model

See [SECURITY.md](./SECURITY.md) for the full threat model and reporting policy. In brief:

- **No telemetry, no network calls** beyond Outreach API endpoints
- **All logging is to stderr only** (stdout is reserved for MCP protocol frames)
- **OAuth tokens** are stored in an on-disk cache with `0600` permissions in `$XDG_CONFIG_HOME/outreach-api-mcp/`
- **Refresh-token rotation** is supported — newest token is written back to cache
- **No tokens, no PII, no message bodies** are ever logged
- **Scope minimization** — only the 19 read scopes needed are requested

## Standards

This codebase commits to a quality bar documented in [STANDARDS.md](./STANDARDS.md). Pull requests are reviewed against it.

## License

[Apache 2.0](./LICENSE).
