// getSequenceProfile — full sequence detail: steps, ruleset, enrollment summary.
//
// Several sub-fetches require scopes that may not be granted
// (`rulesets.read`, `sequenceSteps.read`, `sequenceTemplates.read`). When
// those fail, the response carries `unavailableSections` so the agent can be
// truthful about what's missing rather than failing the whole tool.

import { profileUrl, runTool } from "./_helpers.js";
import { OutreachApiException } from "../api/client.js";
import { relId } from "../api/filters.js";

export interface GetSequenceProfileInput {
  readonly sequenceId: number;
}

const SUMMARY_STATES = [
  "active",
  "paused",
  "finished",
  "bounced",
  "opted_out",
  "failed",
  "pending",
] as const;

interface RulesetShape {
  readonly id: number;
  readonly name?: unknown;
  readonly autoResumeOotoProspects?: unknown;
  readonly permitDuplicateProspects?: unknown;
}

export async function getSequenceProfile(input: GetSequenceProfileInput): Promise<string> {
  return runTool("getSequenceProfile", input, async ({ client }) => {
    const id = input.sequenceId;
    const unavailableSections: string[] = [];

    const sequence = await client.get("sequence", id, {
      includes: ["owner"],
      fields: {
        sequence: [
          "name",
          "description",
          "enabled",
          "shareType",
          "sequenceType",
          "sequenceStepCount",
          "createdAt",
          "updatedAt",
        ],
        user: ["firstName", "lastName", "email"],
      },
      flatten: { owner: ["firstName", "lastName", "email"] },
    });

    let ruleset: RulesetShape | null = null;
    if (sequence["rulesetId"] !== undefined && sequence["rulesetId"] !== null) {
      try {
        const rs = await client.get("ruleset", sequence["rulesetId"] as number, {
          fields: { ruleset: ["name", "autoResumeOotoProspects", "permitDuplicateProspects"] },
        });
        ruleset = {
          id: rs["id"] as number,
          name: rs["name"],
          autoResumeOotoProspects: rs["autoResumeOotoProspects"],
          permitDuplicateProspects: rs["permitDuplicateProspects"],
        };
      } catch (e) {
        if (isScopeMissing(e)) {
          unavailableSections.push("ruleset (requires rulesets.read scope)");
          ruleset = { id: sequence["rulesetId"] as number };
        } else {
          throw e;
        }
      }
    }

    let steps: Record<string, unknown>[] = [];
    try {
      const stepsResult = await client.list("sequenceStep", {
        filters: { sequence: relId(id) },
        fields: { sequenceStep: ["order", "stepType", "interval", "date"] },
        pageSize: 50,
        sort: "order",
      });
      steps = stepsResult.data.map((s) => ({
        id: s["id"],
        order: s["order"],
        stepType: s["stepType"],
        interval: s["interval"],
        date: s["date"],
        templateId: null as number | null,
        templateName: null as string | null,
        templateSubject: null as string | null,
      }));

      if (steps.length > 0) {
        const stepIds = steps
          .map((s) => s["id"])
          .filter((sid): sid is number => typeof sid === "number");
        try {
          const seqTemplates = await client.list("sequenceTemplate", {
            filters: { sequenceStep: relId(stepIds) },
            includes: ["template"],
            fields: { sequenceTemplate: [], template: ["name", "subject"] },
            flatten: { template: ["name", "subject"] },
            pageSize: 200,
          });
          const stepIdToTemplate = new Map<
            number,
            { templateId: number; templateName: string; templateSubject: string }
          >();
          for (const st of seqTemplates.data) {
            const sId = st["sequenceStepId"];
            const tId = st["templateId"];
            if (typeof sId === "number" && typeof tId === "number" && !stepIdToTemplate.has(sId)) {
              stepIdToTemplate.set(sId, {
                templateId: tId,
                templateName: (st["templateName"] as string | undefined) ?? "",
                templateSubject: (st["templateSubject"] as string | undefined) ?? "",
              });
            }
          }
          steps = steps.map((s) => {
            const match = stepIdToTemplate.get(s["id"] as number);
            if (match === undefined) return s;
            return {
              ...s,
              templateId: match.templateId,
              templateName: match.templateName,
              templateSubject: match.templateSubject,
            };
          });
        } catch (e) {
          if (isScopeMissing(e)) {
            unavailableSections.push("step templates (requires sequenceTemplates.read scope)");
          } else {
            throw e;
          }
        }
      }
    } catch (e) {
      if (isScopeMissing(e)) {
        unavailableSections.push("steps (requires sequenceSteps.read scope)");
      } else {
        throw e;
      }
    }

    const allStates = await client.list<{ state: string; sequenceId: number }>("sequenceState", {
      filters: { sequence: relId(id) },
      fields: { sequenceState: ["state"] },
      pageSize: 1000,
    });
    const summary: Record<string, number> = {};
    for (const s of SUMMARY_STATES) summary[s] = 0;
    for (const s of allStates.data) {
      summary[s.state] = (summary[s.state] ?? 0) + 1;
    }
    summary["totalEnrolled"] = allStates.data.length;

    return {
      sequence: {
        id: sequence["id"],
        name: sequence["name"],
        description: sequence["description"],
        enabled: sequence["enabled"],
        shareType: sequence["shareType"],
        sequenceType: sequence["sequenceType"],
        sequenceStepCount: sequence["sequenceStepCount"],
        createdAt: sequence["createdAt"],
        updatedAt: sequence["updatedAt"],
        profileUrl: profileUrl("sequence", id),
      },
      owner:
        sequence["ownerId"] !== undefined
          ? {
              id: sequence["ownerId"],
              name: nameFromParts(sequence["ownerFirstName"], sequence["ownerLastName"]),
              email: sequence["ownerEmail"],
            }
          : null,
      ruleset,
      steps,
      enrollmentSummary: summary,
      unavailableSections: unavailableSections.length > 0 ? unavailableSections : undefined,
    };
  });
}

function isScopeMissing(e: unknown): boolean {
  return e instanceof OutreachApiException && e.envelope.error === "scopeMissing";
}

function nameFromParts(first: unknown, last: unknown): string | undefined {
  if (typeof first !== "string" && typeof last !== "string") return undefined;
  const combined =
    `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
  return combined === "" ? undefined : combined;
}
