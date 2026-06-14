#!/usr/bin/env node
// outreach-api-mcp — MCP server for the Outreach v2 REST API.
//
// The server runs over stdio and registers 21 read-only tools (19 capability
// tools + 2 escape hatches). Tool implementations live in src/tools/; this
// file wires them up to the MCP SDK and starts the transport.
//
// The j/worker shims at the top mimic the @notionhq/workers schema-builder
// API so the registration call shape stays identical to the source repo this
// was ported from — see /STANDARDS.md for the rationale and gong-api-mcp for
// the precedent.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape, type ZodType } from "zod";

import { loadRuntimeConfig } from "./config/index.js";
import { configureLogger, logger } from "./logger.js";
import { analyzeSequencePerformance } from "./tools/analyzeSequencePerformance.js";
import { compareSequences } from "./tools/compareSequences.js";
import { draftEmail } from "./tools/draftEmail.js";
import { getAccountProfile } from "./tools/getAccountProfile.js";
import { getAuditLog } from "./tools/getAuditLog.js";
import { getOpenTasks } from "./tools/getOpenTasks.js";
import { getProspectProfile } from "./tools/getProspectProfile.js";
import { getProspectSequenceHistory } from "./tools/getProspectSequenceHistory.js";
import { getRecentMailings } from "./tools/getRecentMailings.js";
import { getSequenceProfile } from "./tools/getSequenceProfile.js";
import { getSnippet } from "./tools/getSnippet.js";
import { getTeamRoster } from "./tools/getTeamRoster.js";
import { getTemplate } from "./tools/getTemplate.js";
import { getUserActivity } from "./tools/getUserActivity.js";
import { outreachGetById } from "./tools/outreachGetById.js";
import { outreachQuery } from "./tools/outreachQuery.js";
import { searchAccounts } from "./tools/searchAccounts.js";
import { searchProspects } from "./tools/searchProspects.js";
import { searchSequences } from "./tools/searchSequences.js";
import { searchSnippets } from "./tools/searchSnippets.js";
import { searchTemplates } from "./tools/searchTemplates.js";

// ─── Server shim ──────────────────────────────────────────────────────────

interface ToolConfig<TArgs extends ZodRawShape> {
  readonly title?: string;
  readonly description: string;
  readonly schema: TArgs;
  readonly execute: (args: z.infer<z.ZodObject<TArgs>>) => Promise<string> | string;
}

class WorkerCompat {
  private readonly server = new McpServer({
    name: "outreach-api-mcp",
    version: "0.1.2",
  });

  tool<TArgs extends ZodRawShape>(name: string, config: ToolConfig<TArgs>): void {
    // DES-03 (§1.4 interop justification): @modelcontextprotocol/sdk's
    // `registerTool` is heavily overloaded and its public types collapse
    // each tool's specific schema/args generics to a wide intersection.
    // We re-type it locally so the call site stays type-safe against
    // TArgs, instead of letting the SDK widen everything to unknown.
    const registerTool = this.server.registerTool.bind(this.server) as (
      n: string,
      c: { title?: string; description?: string; inputSchema?: TArgs },
      cb: (args: Record<string, unknown>) => Promise<{
        content: { type: "text"; text: string }[];
      }>,
    ) => void;

    registerTool(
      name,
      {
        ...(config.title !== undefined && { title: config.title }),
        description: config.description,
        inputSchema: config.schema,
      },
      async (args) => ({
        content: [
          {
            type: "text",
            // DES-03 (§1.4 interop justification): the MCP SDK passes the
            // tool callback `Record<string, unknown>` after zod validation
            // succeeded; the inferred zod shape matches at runtime but the
            // SDK doesn't preserve that in its types. Safe by construction.
            text: await config.execute(args as z.infer<z.ZodObject<TArgs>>),
          },
        ],
      }),
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// ─── Schema builder shim ───────────────────────────────────────────────────
// Mirrors @notionhq/workers/schema-builder so tool registration call sites
// look identical to the source repo. zod handles .nullable(), .describe(),
// .optional() natively.

const j = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
  array: <T extends ZodType>(t: T) => z.array(t),
  object: <TArgs extends ZodRawShape>(shape: TArgs): TArgs => shape,
};

const worker = new WorkerCompat();

// ─── Tier 1 · Block A — prospects & accounts ──────────────────────────────

worker.tool("searchProspects", {
  title: "Search Prospects",
  description:
    "Find prospects by name, email, company, account, owner, stage, or recent activity. Returns up to 25 normalized prospect rows with profile URLs and active-sequence counts. Two-step lookups for companyName / ownerName / stage are handled internally; returns ambiguousMatch when a name resolves to multiple results.",
  schema: j.object({
    query: j
      .string()
      .describe("Free-text matched against firstName, lastName, emails, title.")
      .nullable(),
    companyName: j.string().describe("Account name; resolved via two-step lookup.").nullable(),
    accountId: j.number().describe("Direct account filter.").nullable(),
    ownerName: j.string().describe("Owner name; resolved via two-step lookup.").nullable(),
    ownerId: j.number().describe("Direct owner filter.").nullable(),
    stage: j.string().describe("Stage name (matched against stage.name).").nullable(),
    hasActiveSequence: j
      .boolean()
      .describe("Only prospects on at least one active sequence.")
      .nullable(),
    updatedSince: j.string().describe("ISO date; only prospects updated since.").nullable(),
    limit: j.number().describe("Default 25, max 100.").nullable(),
  }),
  execute: searchProspects,
});

worker.tool("getProspectProfile", {
  title: "Get Prospect Profile",
  description:
    "Full 360 view of a single prospect: profile, account, active sequences, recent mailings (30 days), recent calls (30 days), open tasks, opportunities, custom fields by admin label. Most expensive tool — composes 6 parallel API calls.",
  schema: j.object({
    prospectId: j.number().describe("Outreach prospect ID."),
    includeMailings: j.boolean().nullable(),
    includeCalls: j.boolean().nullable(),
    includeTasks: j.boolean().nullable(),
    includeOpportunities: j.boolean().nullable(),
    includeCustomFields: j.boolean().nullable(),
  }),
  execute: getProspectProfile,
});

worker.tool("searchAccounts", {
  title: "Search Accounts",
  description:
    "Find accounts by name, domain, owner, industry, named flag, buyer-intent score, or recent updates. Use before getAccountProfile when only a company name is known.",
  schema: j.object({
    query: j.string().describe("Matched against name, naturalName, domain.").nullable(),
    domain: j.string().describe("Exact domain match.").nullable(),
    ownerId: j.number().nullable(),
    ownerName: j.string().nullable(),
    industry: j.string().nullable(),
    named: j.boolean().describe("Only named (account-based) accounts.").nullable(),
    buyerIntentScoreMin: j.number().nullable(),
    updatedSince: j.string().nullable(),
    limit: j.number().describe("Default 25, max 100.").nullable(),
  }),
  execute: searchAccounts,
});

worker.tool("getAccountProfile", {
  title: "Get Account Profile",
  description:
    "Full account view with prospects (top 50 by engagement), opportunities, and last-30-days activity rollup. For 'tell me about [company]' or account-based planning.",
  schema: j.object({
    accountId: j.number().describe("Outreach account ID."),
    includeProspects: j.boolean().nullable(),
    includeOpportunities: j.boolean().nullable(),
    includeRecentActivity: j.boolean().nullable(),
  }),
  execute: getAccountProfile,
});

// ─── Tier 1 · Block B — sequences ──────────────────────────────────────────

worker.tool("searchSequences", {
  title: "Search Sequences",
  description:
    "Find sequences by name, owner, enabled flag, share type, or recent updates. Returns active prospect count per sequence.",
  schema: j.object({
    query: j.string().nullable(),
    ownerId: j.number().nullable(),
    ownerName: j.string().nullable(),
    enabled: j.boolean().nullable(),
    shareType: j.string().describe("e.g. 'private', 'shared'.").nullable(),
    updatedSince: j.string().nullable(),
    limit: j.number().describe("Default 25.").nullable(),
  }),
  execute: searchSequences,
});

worker.tool("getSequenceProfile", {
  title: "Get Sequence Profile",
  description:
    "Full sequence detail: steps (ordered), ruleset, enrollment summary by state. Surfaces unavailableSections when sub-fetches hit scope gaps.",
  schema: j.object({
    sequenceId: j.number(),
  }),
  execute: getSequenceProfile,
});

worker.tool("analyzeSequencePerformance", {
  title: "Analyze Sequence Performance",
  description:
    "Aggregated open/click/reply/bounce/optout/completion rates for one sequence over a date range, optionally grouped by day, week, step, or rep. Pre-flights count; returns tooLarge envelope if dataset exceeds 50_000 records.",
  schema: j.object({
    sequenceId: j.number(),
    dateRangeFrom: j.string().describe("ISO date. Default 30 days ago.").nullable(),
    dateRangeTo: j.string().describe("ISO date. Default today.").nullable(),
    groupBy: j.string().describe("'day' | 'week' | 'step' | 'rep'.").nullable(),
  }),
  execute: analyzeSequencePerformance,
});

worker.tool("compareSequences", {
  title: "Compare Sequences",
  description:
    "Side-by-side performance for 2-5 sequences over the same date range. Returns per-sequence rates plus winners on open/reply/completion.",
  schema: j.object({
    sequenceIds: j.array(j.number()).describe("2-5 sequence IDs."),
    dateRangeFrom: j.string().nullable(),
    dateRangeTo: j.string().nullable(),
  }),
  execute: compareSequences,
});

worker.tool("getProspectSequenceHistory", {
  title: "Get Prospect Sequence History",
  description:
    "Every sequence a prospect has ever been on, chronologically (newest first), with state transitions and durations.",
  schema: j.object({
    prospectId: j.number(),
  }),
  execute: getProspectSequenceHistory,
});

// ─── Tier 1 · Block C — templates & snippets ──────────────────────────────

worker.tool("searchTemplates", {
  title: "Search Templates",
  description:
    "Find email templates by name, owner, or content keyword. Returns name, subject, preview, sequence usage count.",
  schema: j.object({
    query: j.string().describe("Matched against name, subject.").nullable(),
    bodyContains: j
      .string()
      .describe("Case-insensitive substring against bodyText/bodyHtml.")
      .nullable(),
    ownerId: j.number().nullable(),
    ownerName: j.string().nullable(),
    limit: j.number().describe("Default 25.").nullable(),
  }),
  execute: searchTemplates,
});

worker.tool("getTemplate", {
  title: "Get Template",
  description:
    "Full template content (subject, bodyHtml, bodyText, CC/BCC) and which sequences and steps use it. Body truncated at 5000 chars.",
  schema: j.object({
    templateId: j.number(),
  }),
  execute: getTemplate,
});

worker.tool("searchSnippets", {
  title: "Search Snippets",
  description: "Find HTML snippets (reusable email fragments) by name or content keyword.",
  schema: j.object({
    query: j.string().nullable(),
    bodyContains: j.string().nullable(),
    ownerId: j.number().nullable(),
    ownerName: j.string().nullable(),
    limit: j.number().nullable(),
  }),
  execute: searchSnippets,
});

worker.tool("getSnippet", {
  title: "Get Snippet",
  description: "Full snippet body (HTML) and owner. Body truncated at 5000 chars.",
  schema: j.object({
    snippetId: j.number(),
  }),
  execute: getSnippet,
});

// ─── Tier 1 · Block D — activity, tasks, audit ────────────────────────────

worker.tool("getOpenTasks", {
  title: "Get Open Tasks",
  description:
    "Incomplete tasks, optionally filtered by owner, prospect, action type, or due date. Sorted by due date ascending.",
  schema: j.object({
    ownerId: j.number().nullable(),
    ownerName: j.string().nullable(),
    prospectId: j.number().nullable(),
    action: j.string().describe("'action_item' | 'call' | 'email' | 'in_person'.").nullable(),
    dueBefore: j.string().describe("ISO date.").nullable(),
    limit: j.number().describe("Default 50.").nullable(),
  }),
  execute: getOpenTasks,
});

worker.tool("getRecentMailings", {
  title: "Get Recent Mailings",
  description:
    "Mailings sent in a date range, filterable by sequence, prospect, template, or state. Default last 1 day.",
  schema: j.object({
    dateRangeFrom: j.string().nullable(),
    dateRangeTo: j.string().nullable(),
    sequenceId: j.number().nullable(),
    prospectId: j.number().nullable(),
    templateId: j.number().nullable(),
    state: j
      .string()
      .describe("'delivered' | 'bounced' | 'opened' | 'clicked' | 'replied' | 'optedOut'.")
      .nullable(),
    limit: j.number().describe("Default 50, max 200.").nullable(),
  }),
  execute: getRecentMailings,
});

worker.tool("getTeamRoster", {
  title: "Get Team Roster",
  description:
    "Active Outreach users on this workspace: name, email, title, ID. Sorted alphabetically.",
  schema: j.object({
    activeOnly: j.boolean().describe("Default true.").nullable(),
  }),
  execute: getTeamRoster,
});

worker.tool("getUserActivity", {
  title: "Get User Activity",
  description:
    "Per-user activity metrics over a date range: prospects owned, active sequences, mailings sent/opened/replied, calls logged/completed, tasks created/completed, top accounts. Default last 30 days.",
  schema: j.object({
    userId: j.number().nullable(),
    userName: j.string().nullable(),
    dateRangeFrom: j.string().nullable(),
    dateRangeTo: j.string().nullable(),
  }),
  execute: getUserActivity,
});

worker.tool("getAuditLog", {
  title: "Get Audit Log",
  description:
    "Who changed what, when. Always require at least one filter (resourceId, userId, or date range ≤ 30 days). Unfiltered queries return validationError.",
  schema: j.object({
    resourceType: j
      .string()
      .describe("'prospect' | 'account' | 'opportunity' | 'sequence' | 'task'.")
      .nullable(),
    resourceId: j.number().nullable(),
    userId: j.number().nullable(),
    dateRangeFrom: j.string().nullable(),
    dateRangeTo: j.string().nullable(),
    limit: j.number().describe("Default 100.").nullable(),
  }),
  execute: getAuditLog,
});

// ─── Tier 1 · Block E — drafting ───────────────────────────────────────────

worker.tool("draftEmail", {
  title: "Draft Email Context Bundle",
  description:
    "Gather context for drafting an email: prospect profile, recent interactions (mailings + calls, last 60 days), optional template, custom fields. The TOOL returns context only; the AGENT composes the actual email in chat for the user to paste into Outreach. Never claim the email was sent.",
  schema: j.object({
    prospectId: j.number(),
    intent: j.string().describe("Free-text purpose of the email."),
    templateId: j.number().describe("Optional starting template.").nullable(),
    toneHints: j.string().describe("e.g. 'casual', 'follow-up after silence'.").nullable(),
    includeRecentContext: j.boolean().describe("Default true.").nullable(),
  }),
  execute: draftEmail,
});

// ─── Tier 2 — escape hatches ───────────────────────────────────────────────

worker.tool("outreachQuery", {
  title: "Generic Outreach Query",
  description:
    "Generic JSON:API query for any read-only resource type. Use only when no capability tool fits. Validates resource against the allowlist; returns invalidResource envelope if not allowed. `filters` and `fields` are JSON-stringified for transport.",
  schema: j.object({
    resource: j.string().describe("Resource type from the allowlist."),
    filters: j.string().describe("JSON-stringified filter map.").nullable(),
    includes: j.array(j.string()).nullable(),
    fields: j
      .string()
      .describe("JSON-stringified resource→fields[] map for sparse fieldsets.")
      .nullable(),
    sort: j.string().nullable(),
    pageSize: j.number().describe("Default 50, max 200.").nullable(),
    cursor: j.string().describe("Opaque cursor from prior nextCursor.").nullable(),
  }),
  execute: outreachQuery,
});

worker.tool("outreachGetById", {
  title: "Generic Outreach Get-by-ID",
  description:
    "Generic by-ID lookup for any read-only resource type. Returns notFound on 404, invalidResource if the type is outside the allowlist.",
  schema: j.object({
    resource: j.string(),
    id: j.number(),
    includes: j.array(j.string()).nullable(),
    fields: j.string().describe("JSON-stringified resource→fields[] map.").nullable(),
  }),
  execute: outreachGetById,
});

// ─── Entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const cfg = loadRuntimeConfig();
    configureLogger(cfg.logLevel);
  } catch (e) {
    // Config errors are surfaced via stderr (not the MCP stdio channel) before
    // the transport opens. If config is missing the user sees the error and
    // re-runs after fixing .env.
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "outreach-api-mcp.startup.configError",
        err: e instanceof Error ? e.message : String(e),
      })}\n`,
    );
    process.exit(1);
  }
  logger.info("outreach-api-mcp.startup", { tools: 21 });
  await worker.start();
}

await main();
