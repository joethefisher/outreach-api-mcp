// OAuth scopes requested by outreach-api-mcp.
//
// All scopes are `*.read`. No write scopes are requested or used — this is
// enforced both at the bootstrap script (which sends this list as the
// `scope` parameter) and at the HTTP client layer (which only issues GET).
//
// To add a tool that needs a new scope:
//   1. Add the scope to this list.
//   2. Re-run `npm run bootstrap:oauth` to re-consent.
//   3. The on-disk cache now holds a token with the broader grant.
//
// Removing a scope DOES NOT revoke it from an existing token — only a
// re-consent does that.

export const OUTREACH_READ_SCOPES: readonly string[] = [
  "accounts.read",
  "auditLogs.read",
  "callDispositions.read",
  "callPurposes.read",
  "calls.read",
  "events.read",
  "mailboxes.read",
  "mailings.read",
  "opportunities.read",
  "opportunityProspectRoles.read",
  "prospects.read",
  "sequences.read",
  "sequenceStates.read",
  "sequenceSteps.read",
  "sequenceTemplates.read",
  "snippets.read",
  "tasks.read",
  "templates.read",
  "users.read",
];

export function scopeString(): string {
  return OUTREACH_READ_SCOPES.join(" ");
}
