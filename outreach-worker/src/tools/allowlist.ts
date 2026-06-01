// Tier-2 read-only resource allowlist.
//
// The `outreachQuery` and `outreachGetById` escape hatches let the agent
// reach any resource by name. We enforce a hardcoded allowlist that mirrors
// the OAuth read scopes — denying by default rather than relying on the
// upstream 403.

export const READ_ONLY_RESOURCES = [
  "account",
  "accountNote",
  "auditLog",
  "call",
  "callDisposition",
  "callPurpose",
  "event",
  "mailbox",
  "mailing",
  "opportunity",
  "opportunityProspectRole",
  "opportunityStage",
  "persona",
  "prospect",
  "prospectNote",
  "sequence",
  "sequenceState",
  "sequenceStep",
  "sequenceTemplate",
  "snippet",
  "stage",
  "task",
  "taskDisposition",
  "taskPurpose",
  "team",
  "template",
  "user",
] as const;

export type AllowedResource = (typeof READ_ONLY_RESOURCES)[number];

const ALLOW_SET = new Set<string>(READ_ONLY_RESOURCES);

export function isAllowedResource(value: string): value is AllowedResource {
  return ALLOW_SET.has(value);
}

/**
 * Sparse fieldset per resource for Tier-2 escape hatches when the caller
 * does not specify `fields`. Keeps response sizes bounded for the agent's
 * context window. Callers may override with explicit `fields[type]=...`.
 */
export const ESSENTIAL_FIELDS: Readonly<Partial<Record<AllowedResource, readonly string[]>>> = {
  account: ["name", "domain", "industry", "named", "buyerIntentScore", "updatedAt"],
  accountNote: [],
  auditLog: [],
  call: ["direction", "outcome", "answeredAt", "duration", "note"],
  callDisposition: ["name"],
  callPurpose: ["name"],
  event: ["name", "createdAt"],
  mailbox: ["email"],
  mailing: ["subject", "state", "deliveredAt", "openedAt", "clickedAt", "repliedAt", "bouncedAt"],
  opportunity: ["name", "amount", "closeDate", "state"],
  opportunityProspectRole: ["role"],
  opportunityStage: ["name"],
  persona: ["name"],
  prospect: ["firstName", "lastName", "title", "emails", "engagedScore", "engagedAt", "updatedAt"],
  prospectNote: [],
  sequence: ["name", "enabled", "shareType", "sequenceStepCount", "createdAt", "updatedAt"],
  sequenceState: ["state", "createdAt", "stateChangedAt", "activeAt"],
  sequenceStep: ["order", "stepType", "interval"],
  sequenceTemplate: [],
  snippet: ["name", "updatedAt"],
  stage: ["name"],
  task: ["action", "state", "note", "dueAt", "createdAt"],
  taskDisposition: ["name"],
  taskPurpose: ["name"],
  team: ["name"],
  template: ["name", "subject", "archived", "updatedAt"],
  user: ["firstName", "lastName", "email", "title", "locked", "createdAt"],
};
