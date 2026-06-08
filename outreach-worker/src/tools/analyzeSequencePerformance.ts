// analyzeSequencePerformance — aggregated open/click/reply/bounce/optout/completion
// rates over a date range, optionally grouped (day, week, step).

import { OutreachApiException, type OutreachClient } from "../api/client.js";
import { range, relId, type FilterMap } from "../api/filters.js";
import { tooLarge } from "../errors/envelopes.js";

import { daysAgoISO, profileUrl, runTool, todayISO, validateDateRange } from "./_helpers.js";

const MAX_PAGES = 50;
const MAX_RECORDS = 50_000;

interface Totals {
  enrolled: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  optedOut: number;
  finished: number;
}

export type GroupBy = "day" | "week" | "step" | "rep";

export interface AnalyzeSequencePerformanceInput {
  readonly sequenceId: number;
  readonly dateRangeFrom?: string | null;
  readonly dateRangeTo?: string | null;
  readonly groupBy?: string | null;
}

interface GroupKeyFn {
  readonly includes: readonly string[];
  readonly fn: (record: Record<string, unknown>) => string | null;
}

async function walkList(
  client: OutreachClient,
  resource: string,
  filters: FilterMap,
  fields: Record<string, readonly string[]>,
  includes: readonly string[] = [],
): Promise<{ data: Record<string, unknown>[]; truncated: boolean }> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | null | undefined;
  let pages = 0;
  let truncated = false;
  for (;;) {
    if (pages >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const page = await client.list(resource, {
      filters,
      fields,
      ...(includes.length > 0 && { includes }),
      pageSize: 1000,
      ...(cursor !== null && cursor !== undefined && cursor !== "" && { cursor }),
    });
    out.push(...page.data);
    pages++;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { data: out, truncated };
}

export async function analyzeSequencePerformance(
  input: AnalyzeSequencePerformanceInput,
): Promise<string> {
  return runTool("analyzeSequencePerformance", input, async ({ client }) => {
    const dateValidation = validateDateRange(input.dateRangeFrom, input.dateRangeTo);
    if (!dateValidation.ok) return dateValidation.envelope;
    const from = dateValidation.range.from ?? daysAgoISO(30);
    const to = dateValidation.range.to ?? todayISO();
    const seqId = input.sequenceId;

    const sequence = await client.get("sequence", seqId, {
      fields: { sequence: ["name"] },
    });

    let mailingCount: { count: number; truncated: boolean };
    try {
      mailingCount = await client.count("mailing", {
        sequence: relId(seqId),
        createdAt: range(`${from}T00:00:00Z`, `${to}T23:59:59Z`),
      });
    } catch (e) {
      // COR-09: discriminate domain failures from programmer mistakes.
      // Outreach API errors mean "can't count, narrow scope" → tooLarge.
      // A TypeError / RangeError / fixture-wiring bug must propagate so
      // it surfaces as a real failure rather than being silently
      // mislabelled "result too large." Mirrors getRecentMailings.ts.
      if (e instanceof OutreachApiException && e.envelope.error === "outreachApiError") {
        return tooLarge(-1, true);
      }
      throw e;
    }
    if (mailingCount.count > MAX_RECORDS || mailingCount.truncated) {
      return tooLarge(mailingCount.count, mailingCount.truncated);
    }

    const totals: Totals = {
      enrolled: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
      bounced: 0,
      optedOut: 0,
      finished: 0,
    };

    let stepOrderById: Map<number, number> | null = null;
    if (input.groupBy === "step") {
      try {
        const stepsResult = await client.list<{ id: number; order: number }>("sequenceStep", {
          filters: { sequence: relId(seqId) },
          fields: { sequenceStep: ["order"] },
          sort: "order",
          pageSize: 100,
        });
        stepOrderById = new Map(stepsResult.data.map((s) => [s.id, s.order]));
      } catch {
        stepOrderById = null;
      }
    }

    const groupKeyFn = pickGroupKey(input.groupBy ?? null, stepOrderById);
    const groupTotals = new Map<string, Totals>();
    const ensureGroup = (key: string): Totals => {
      let g = groupTotals.get(key);
      if (g === undefined) {
        g = {
          enrolled: 0,
          delivered: 0,
          opened: 0,
          clicked: 0,
          replied: 0,
          bounced: 0,
          optedOut: 0,
          finished: 0,
        };
        groupTotals.set(key, g);
      }
      return g;
    };

    const mailingFields = [
      "state",
      "createdAt",
      "deliveredAt",
      "openedAt",
      "clickedAt",
      "repliedAt",
      "bouncedAt",
      ...(input.groupBy === "step" ? ["sequenceStep"] : []),
    ];

    const [mailings, states] = await Promise.all([
      walkList(
        client,
        "mailing",
        {
          sequence: relId(seqId),
          createdAt: range(`${from}T00:00:00Z`, `${to}T23:59:59Z`),
        },
        { mailing: mailingFields },
        input.groupBy === "step" ? ["sequenceStep"] : [],
      ),
      walkList(
        client,
        "sequenceState",
        {
          sequence: relId(seqId),
          createdAt: range(`${from}T00:00:00Z`, `${to}T23:59:59Z`),
        },
        { sequenceState: ["state", "createdAt", "stateChangedAt"] },
      ),
    ]);

    for (const m of mailings.data) {
      const state = m["state"] as string | undefined;
      const bounced = state === "bounced";
      const delivered = !bounced && m["deliveredAt"] !== undefined && m["deliveredAt"] !== null;
      // COR-04: open/click/reply only count for delivered mail. A bounced-
      // but-opened mailing pushed openRate over 1.0 in the prior version
      // because the numerator counted any timestamped open while the
      // denominator excluded bounces.
      const opened = delivered && m["openedAt"] !== undefined && m["openedAt"] !== null;
      const clicked = delivered && m["clickedAt"] !== undefined && m["clickedAt"] !== null;
      const replied = delivered && m["repliedAt"] !== undefined && m["repliedAt"] !== null;

      if (bounced) totals.bounced++;
      else if (delivered) totals.delivered++;
      if (opened) totals.opened++;
      if (clicked) totals.clicked++;
      if (replied) totals.replied++;
      if (state === "optedOut") totals.optedOut++;

      if (groupKeyFn !== null) {
        const key = groupKeyFn.fn(m);
        if (key !== null) {
          const g = ensureGroup(key);
          if (bounced) g.bounced++;
          else if (delivered) g.delivered++;
          if (opened) g.opened++;
          if (clicked) g.clicked++;
          if (replied) g.replied++;
          if (state === "optedOut") g.optedOut++;
        }
      }
    }

    for (const s of states.data) {
      totals.enrolled++;
      if (s["state"] === "finished") totals.finished++;
      if (groupKeyFn !== null) {
        const key = groupKeyFn.fn(s);
        if (key !== null) {
          const g = ensureGroup(key);
          g.enrolled++;
          if (s["state"] === "finished") g.finished++;
        }
      }
    }

    const groupsSection =
      groupKeyFn === null
        ? {}
        : {
            groups: Array.from(groupTotals.entries())
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([key, g]) => ({ key, totals: g, rates: rates(g) })),
          };

    const notes: string[] = [
      "Mailings counted by createdAt (sent timestamp); sequenceStates counted by createdAt (enrollment).",
      "deliveryRate denominator = delivered + bounced (mailings actually sent), not enrolled.",
    ];
    if (input.groupBy === "step") {
      if (stepOrderById === null) {
        notes.push(
          'groupBy="step" — couldn\'t fetch sequenceSteps (sequenceSteps.read scope missing or transient error). groups[] is empty.',
        );
      } else {
        notes.push(
          'groupBy="step" — mailings grouped by their sequenceStep order. SequenceState enrolled/finished counts are NOT grouped per step (Outreach v2 doesn\'t link sequenceState → step).',
        );
      }
    }
    if (input.groupBy === "rep") {
      notes.push(
        'groupBy="rep" requested but unsupported — would require traversing mailbox.user (mailboxes.read scope not granted). groups[] is empty.',
      );
    }

    return {
      sequenceName: sequence["name"],
      sequenceProfileUrl: profileUrl("sequence", seqId),
      dateRange: { from, to },
      totals,
      rates: rates(totals),
      ...groupsSection,
      truncated: mailings.truncated || states.truncated,
      notes,
    };
  });
}

function rates(t: Totals): Record<string, number> {
  const safe = (num: number, denom: number): number =>
    denom === 0 ? 0 : Number((num / denom).toFixed(4));
  const sent = t.delivered + t.bounced;
  return {
    deliveryRate: safe(t.delivered, sent),
    openRate: safe(t.opened, t.delivered),
    clickRate: safe(t.clicked, t.delivered),
    replyRate: safe(t.replied, t.delivered),
    bounceRate: safe(t.bounced, sent),
    optOutRate: safe(t.optedOut, t.delivered),
    completionRate: safe(t.finished, t.enrolled),
  };
}

function pickGroupKey(
  groupBy: string | null,
  stepOrderById: Map<number, number> | null,
): GroupKeyFn | null {
  if (groupBy === null || groupBy === "") return null;
  if (groupBy === "day") {
    return {
      includes: [],
      fn: (r) => {
        const dt = (r["deliveredAt"] ?? r["createdAt"]) as string | undefined;
        return typeof dt === "string" ? dt.slice(0, 10) : null;
      },
    };
  }
  if (groupBy === "week") {
    return {
      includes: [],
      fn: (r) => {
        const dt = (r["deliveredAt"] ?? r["createdAt"]) as string | undefined;
        if (typeof dt !== "string") return null;
        const d = new Date(dt);
        const monday = new Date(d);
        const day = (d.getUTCDay() + 6) % 7;
        monday.setUTCDate(d.getUTCDate() - day);
        return monday.toISOString().slice(0, 10);
      },
    };
  }
  if (groupBy === "step") {
    return {
      includes: ["sequenceStep"],
      fn: (r) => {
        const stepId = r["sequenceStepId"];
        if (typeof stepId !== "number" || stepOrderById === null) return null;
        const order = stepOrderById.get(stepId);
        if (order === undefined) return null;
        return `Step ${String(order)}`;
      },
    };
  }
  if (groupBy === "rep") {
    return { includes: ["mailbox.user"], fn: () => null };
  }
  return null;
}
