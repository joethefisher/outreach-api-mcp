# Outreach API MCP

Public-safe [Model Context Protocol](https://modelcontextprotocol.io) server for querying [Outreach](https://www.outreach.io) sales engagement data — prospects, accounts, sequences, templates, snippets, tasks, mailings, audit logs — from your own Outreach workspace.

This project is an independent integration and is **not affiliated with, endorsed by, or sponsored by Outreach**. Users are responsible for complying with Outreach's API terms and for using their own OAuth credentials and workspace data.

## Status

The MCP server in [`outreach-worker`](./outreach-worker) runs over stdio against the Outreach v2 REST API. Read-only by design (no write scopes requested or used).

## Prerequisites

1. **Node.js ≥ 20**
2. **An Outreach OAuth application** registered in your own Outreach workspace. See [Outreach's OAuth docs](https://developers.outreach.io/api/oauth/) for the registration flow. You will need:
   - The app's `client_id` and `client_secret`
   - A registered redirect URI of `http://127.0.0.1:8765/callback` (or whatever port you configure)
   - The scopes listed in [`outreach-worker/src/auth/scopes.ts`](./outreach-worker/src/auth/scopes.ts)

## Quick start

```bash
git clone https://github.com/joethefisher/outreach-api-mcp.git
cd outreach-api-mcp/outreach-worker
npm ci
npm run build

# One-time consent flow — opens your browser, captures the refresh token.
OUTREACH_CLIENT_ID=...  OUTREACH_CLIENT_SECRET=...  npm run bootstrap:oauth

# Bootstrap prints a .env block. Save it to ../.env (or wherever your MCP
# client sources env from), then point your MCP client at:
#
#   command: node
#   args: ["/abs/path/to/outreach-api-mcp/outreach-worker/dist/index.js"]
#
# with the env vars from .env loaded.
```

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
