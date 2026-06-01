// getProspectSequenceHistory — every sequence a prospect has been on, chronologically.

import { profileUrl, runTool } from "./_helpers.js";
import { relId } from "../api/filters.js";

export interface GetProspectSequenceHistoryInput {
  readonly prospectId: number;
}

const TERMINAL_STATES = /^(finished|disabled|failed|opted_out|bounced)$/;

export async function getProspectSequenceHistory(
  input: GetProspectSequenceHistoryInput,
): Promise<string> {
  return runTool("getProspectSequenceHistory", input, async ({ client }) => {
    const id = input.prospectId;

    const [prospect, states] = await Promise.all([
      client.get("prospect", id, {
        fields: { prospect: ["firstName", "lastName"] },
      }),
      client.list("sequenceState", {
        filters: { prospect: relId(id) },
        includes: ["sequence"],
        fields: {
          sequenceState: ["state", "createdAt", "stateChangedAt", "activeAt"],
          sequence: ["name"],
        },
        flatten: { sequence: ["name"] },
        sort: "-createdAt",
        pageSize: 100,
      }),
    ]);

    return {
      prospectName:
        `${(prospect["firstName"] as string | undefined) ?? ""} ${(prospect["lastName"] as string | undefined) ?? ""}`.trim(),
      prospectProfileUrl: profileUrl("prospect", id),
      history: states.data.map((s) => {
        const enrolled =
          typeof s["createdAt"] === "string" ? new Date(s["createdAt"]).getTime() : null;
        const stateName = s["state"] as string | undefined;
        const ended =
          stateName !== undefined && TERMINAL_STATES.test(stateName) ? s["stateChangedAt"] : null;
        const endedMs = typeof ended === "string" ? new Date(ended).getTime() : null;
        const durationDays =
          enrolled !== null && endedMs !== null
            ? Math.round((endedMs - enrolled) / (1000 * 60 * 60 * 24))
            : null;
        const sequenceId = s["sequenceId"];
        return {
          sequenceStateId: s["id"],
          sequenceId,
          sequenceName: s["sequenceName"],
          sequenceProfileUrl:
            typeof sequenceId === "number" ? profileUrl("sequence", sequenceId) : null,
          state: stateName,
          enrolledAt: s["createdAt"],
          finishedAt: ended ?? null,
          durationDays,
          currentStepNumber: undefined,
          lastStateChangeAt: s["stateChangedAt"],
          mailboxOwnerName: undefined,
        };
      }),
    };
  });
}
