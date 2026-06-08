// getAuditLog — who changed what, when. Always require at least one filter.

import { type FilterMap } from "../api/filters.js";
import { validationError } from "../errors/envelopes.js";

import { runTool, validateDateRange } from "./_helpers.js";

export interface GetAuditLogInput {
  readonly resourceType?: string | null;
  readonly resourceId?: number | null;
  readonly userId?: number | null;
  readonly dateRangeFrom?: string | null;
  readonly dateRangeTo?: string | null;
  readonly limit?: number | null;
}

const NARROW_DAYS = 30;

export async function getAuditLog(input: GetAuditLogInput): Promise<string> {
  return runTool("getAuditLog", input, async ({ client }) => {
    const limit = clamp(input.limit ?? 100, 1, 500);

    const dateValidation = validateDateRange(input.dateRangeFrom, input.dateRangeTo);
    if (!dateValidation.ok) return dateValidation.envelope;

    const hasResource =
      input.resourceId !== null && input.resourceId !== undefined && input.resourceId !== 0;
    const hasUser = input.userId !== null && input.userId !== undefined && input.userId !== 0;
    const from = dateValidation.range.from;
    const to = dateValidation.range.to;
    const narrowDateRange = from !== null && to !== null && daySpan(from, to) <= NARROW_DAYS;

    if (!hasResource && !hasUser && !narrowDateRange) {
      return validationError(
        "getAuditLog requires at least one filter: resourceId, userId, or a date range of 30 days or less.",
      );
    }

    const filters: FilterMap = {};
    const result = await client.list("auditLog", {
      filters,
      pageSize: limit,
    });

    let entries = [...result.data];
    const wantResourceId =
      input.resourceId !== null && input.resourceId !== undefined ? String(input.resourceId) : null;
    const wantResourceType =
      input.resourceType !== null && input.resourceType !== undefined && input.resourceType !== ""
        ? input.resourceType
        : null;
    // Date bounds normalized to ISO timestamps for string comparison; null
    // on either side means "no bound on that side." Always applied so an
    // audit query is never returned outside its documented window (COR-01).
    const fromTs = from !== null ? `${from}T00:00:00Z` : null;
    const toTs = to !== null ? `${to}T23:59:59Z` : null;

    if (
      wantResourceId !== null ||
      wantResourceType !== null ||
      hasUser ||
      fromTs !== null ||
      toTs !== null
    ) {
      entries = entries.filter((e) => {
        const info =
          (e["additionalInfo"] as { field?: string; value?: unknown }[] | undefined) ?? [];
        const find = (k: string): unknown => info.find((p) => p.field === k)?.value;
        if (wantResourceId !== null) {
          const raw = e["resourceId"] ?? find("resource_id") ?? "";
          const id = typeof raw === "number" || typeof raw === "string" ? String(raw) : "";
          if (id !== wantResourceId) return false;
        }
        if (wantResourceType !== null) {
          const raw = e["resourceType"] ?? find("type") ?? find("resource_type") ?? "";
          const t = typeof raw === "string" ? raw.toLowerCase() : "";
          if (t !== wantResourceType.toLowerCase()) return false;
        }
        if (hasUser) {
          const agent = e["agent"] as { userId?: unknown } | undefined;
          const directUserId = e["userId"];
          const agentUserId = agent?.userId;
          const candidate =
            typeof directUserId === "number" || typeof directUserId === "string"
              ? directUserId
              : typeof agentUserId === "number" || typeof agentUserId === "string"
                ? agentUserId
                : "";
          if (String(candidate) !== String(input.userId)) return false;
        }
        if (fromTs !== null || toTs !== null) {
          // Outreach auditLog timestamps as `occurredAt` (preferred) with
          // `createdAt` fallback. Drop entries lacking both — better to omit
          // than to surface them as "in range" with no actual timestamp.
          const ts =
            (e["occurredAt"] as string | undefined) ?? (e["createdAt"] as string | undefined) ?? "";
          if (ts === "") return false;
          if (fromTs !== null && ts < fromTs) return false;
          if (toTs !== null && ts > toTs) return false;
        }
        return true;
      });
    }

    return {
      entries: entries.map((e) => ({
        id: e["id"],
        action: e["action"],
        additionalInfo: e["additionalInfo"],
        agent: e["agent"],
        resourceId: e["resourceId"],
        resourceType: e["resourceType"],
        userId: e["userId"],
      })),
      truncated: result.nextCursor !== null,
      note: "Outreach v2 auditLog returns action + additionalInfo (field/value pairs) + agent metadata. API filters are not supported; resource/user/date filters are applied client-side after fetching the most recent page.",
    };
  });
}

function daySpan(from: string, to: string): number {
  const f = new Date(from).getTime();
  const t = new Date(to).getTime();
  return Math.floor((t - f) / (24 * 60 * 60 * 1000));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
