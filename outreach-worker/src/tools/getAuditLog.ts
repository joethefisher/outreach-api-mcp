// getAuditLog — who changed what, when. Always require at least one filter.

import { runTool } from "./_helpers.js";
import { type FilterMap } from "../api/filters.js";
import { validationError } from "../errors/envelopes.js";

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

    const hasResource =
      input.resourceId !== null && input.resourceId !== undefined && input.resourceId !== 0;
    const hasUser = input.userId !== null && input.userId !== undefined && input.userId !== 0;
    const from = input.dateRangeFrom;
    const to = input.dateRangeTo;
    const narrowDateRange =
      from !== null &&
      from !== undefined &&
      from !== "" &&
      to !== null &&
      to !== undefined &&
      to !== "" &&
      daySpan(from, to) <= NARROW_DAYS;

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
    if (wantResourceId !== null || wantResourceType !== null || hasUser) {
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
      note: "Outreach v2 auditLog returns action + additionalInfo (field/value pairs) + agent metadata. API filters are not supported; resource/user filters are applied client-side.",
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
