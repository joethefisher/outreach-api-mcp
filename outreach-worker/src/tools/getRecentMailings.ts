// getRecentMailings — mailings sent in a date range, filterable.

import { OutreachApiException } from "../api/client.js";
import { range, relId, type FilterMap } from "../api/filters.js";
import { tooLarge } from "../errors/envelopes.js";

import { daysAgoISO, profileUrl, runTool, todayISO, validateDateRange } from "./_helpers.js";

export interface GetRecentMailingsInput {
  readonly dateRangeFrom?: string | null;
  readonly dateRangeTo?: string | null;
  readonly sequenceId?: number | null;
  readonly prospectId?: number | null;
  readonly templateId?: number | null;
  readonly state?: string | null;
  readonly limit?: number | null;
}

const MAX_RECORDS = 5000;

export async function getRecentMailings(input: GetRecentMailingsInput): Promise<string> {
  return runTool("getRecentMailings", input, async ({ client }) => {
    const dateValidation = validateDateRange(input.dateRangeFrom, input.dateRangeTo);
    if (!dateValidation.ok) return dateValidation.envelope;
    const from = dateValidation.range.from ?? daysAgoISO(1);
    const to = dateValidation.range.to ?? todayISO();
    const limit = clamp(input.limit ?? 50, 1, 200);

    const filters: Record<string, unknown> = {
      createdAt: range(`${from}T00:00:00Z`, `${to}T23:59:59Z`),
    };
    if (input.sequenceId !== null && input.sequenceId !== undefined) {
      filters["sequence"] = relId(input.sequenceId);
    }
    if (input.prospectId !== null && input.prospectId !== undefined) {
      filters["prospect"] = relId(input.prospectId);
    }
    if (input.templateId !== null && input.templateId !== undefined) {
      filters["template"] = relId(input.templateId);
    }
    if (isNonEmpty(input.state)) filters["state"] = input.state;

    let countResult: { count: number; truncated: boolean };
    try {
      countResult = await client.count("mailing", filters as FilterMap);
    } catch (e) {
      if (e instanceof OutreachApiException && e.envelope.error === "outreachApiError") {
        return tooLarge(-1, true);
      }
      throw e;
    }
    if (countResult.count > MAX_RECORDS || countResult.truncated) {
      return tooLarge(countResult.count, countResult.truncated);
    }

    const result = await client.list("mailing", {
      filters: filters as FilterMap,
      includes: ["prospect", "sequence", "template"],
      fields: {
        mailing: [
          "subject",
          "state",
          "deliveredAt",
          "openedAt",
          "clickedAt",
          "repliedAt",
          "bouncedAt",
          "createdAt",
        ],
        prospect: ["firstName", "lastName"],
        sequence: ["name"],
        template: ["name"],
      },
      flatten: {
        prospect: ["firstName", "lastName"],
        sequence: ["name"],
        template: ["name"],
      },
      sort: "-createdAt",
      pageSize: limit,
    });

    return {
      mailings: result.data.map((m) => {
        const prospectId = m["prospectId"];
        return {
          id: m["id"],
          subject: m["subject"],
          state: m["state"],
          deliveredAt: m["deliveredAt"],
          openedAt: m["openedAt"] ?? null,
          clickedAt: m["clickedAt"] ?? null,
          repliedAt: m["repliedAt"] ?? null,
          bouncedAt: m["bouncedAt"] ?? null,
          prospectId,
          prospectName: nameFromParts(m["prospectFirstName"], m["prospectLastName"]),
          accountName: undefined,
          sequenceId: m["sequenceId"],
          sequenceName: m["sequenceName"],
          templateName: m["templateName"],
          mailboxOwnerName: undefined,
          profileUrl:
            typeof prospectId === "number" ? profileUrl("prospect", prospectId) : undefined,
        };
      }),
      truncated: result.nextCursor !== null,
      dateRange: { from, to },
    };
  });
}

function isNonEmpty(s: string | null | undefined): s is string {
  return s !== null && s !== undefined && s !== "";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function nameFromParts(first: unknown, last: unknown): string | undefined {
  if (typeof first !== "string" && typeof last !== "string") return undefined;
  const combined =
    `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
  return combined === "" ? undefined : combined;
}
