// draftEmail — gathers context for the agent to compose an email.
//
// Important: this tool does NOT generate text. It returns a context bundle.
// The agent's system prompt covers the drafting playbook — read context,
// write subject + body, present in chat, remind user to copy into Outreach.

import { daysAgoISO, profileUrl, runTool } from "./_helpers.js";
import { range, relId } from "../api/filters.js";

export interface DraftEmailInput {
  readonly prospectId: number;
  readonly intent: string;
  readonly templateId?: number | null;
  readonly toneHints?: string | null;
  readonly includeRecentContext?: boolean | null;
}

export async function draftEmail(input: DraftEmailInput): Promise<string> {
  return runTool("draftEmail", input, async ({ client, schema }) => {
    const id = input.prospectId;
    const includeContext = input.includeRecentContext !== false;
    const since = daysAgoISO(60);

    const emptyPage = Promise.resolve({
      data: [] as readonly Record<string, unknown>[],
      nextCursor: null,
    });

    const [prospect, mailings, calls, template] = await Promise.all([
      client.get("prospect", id, {
        includes: ["account", "owner"],
        fields: {
          prospect: [
            "firstName",
            "lastName",
            "title",
            "emails",
            "stageName",
            "engagedScore",
            "engagedAt",
            "custom1",
            "custom2",
            "custom3",
            "custom4",
            "custom5",
          ],
          account: ["name", "domain", "industry"],
          user: ["firstName", "lastName"],
        },
        flatten: {
          account: ["name", "domain", "industry"],
          owner: ["firstName", "lastName"],
        },
      }),
      includeContext
        ? client.list("mailing", {
            filters: {
              prospect: relId(id),
              createdAt: range(`${since}T00:00:00Z`, new Date().toISOString()),
            },
            includes: ["template"],
            fields: {
              mailing: [
                "subject",
                "state",
                "deliveredAt",
                "openedAt",
                "clickedAt",
                "repliedAt",
                "createdAt",
              ],
              template: ["name"],
            },
            flatten: { template: ["name"] },
            pageSize: 5,
            sort: "-createdAt",
          })
        : emptyPage,
      includeContext
        ? client.list("call", {
            filters: { prospect: relId(id) },
            fields: { call: ["direction", "outcome", "answeredAt", "note"] },
            pageSize: 25,
          })
        : emptyPage,
      input.templateId !== null && input.templateId !== undefined
        ? client.get("template", input.templateId, {
            fields: { template: ["name", "subject", "bodyHtml", "bodyText"] },
          })
        : Promise.resolve(null),
    ]);

    const labelled = schema.applyLabelsTo("prospect", { ...prospect });

    const recentCalls = [...calls.data]
      .filter((c) => typeof c["answeredAt"] === "string" && c["answeredAt"] >= `${since}T00:00:00Z`)
      .sort((a, b) =>
        ((b["answeredAt"] as string | undefined) ?? "").localeCompare(
          (a["answeredAt"] as string | undefined) ?? "",
        ),
      )
      .slice(0, 5);

    const recentInteractions = [
      ...mailings.data.map((m) => {
        const repliedAt = m["repliedAt"];
        const openedAt = m["openedAt"];
        const repliedSuffix = typeof repliedAt === "string" ? `; replied at ${repliedAt}` : "";
        const openedSuffix = typeof openedAt === "string" ? `; opened at ${openedAt}` : "";
        return {
          type: "mailing",
          date: m["deliveredAt"] ?? m["createdAt"],
          subject_or_outcome: m["subject"],
          summary: `Template: ${(m["templateName"] as string | undefined) ?? "—"}; state: ${(m["state"] as string | undefined) ?? "—"}${repliedSuffix}${openedSuffix}`,
        };
      }),
      ...recentCalls.map((c) => ({
        type: "call",
        date: c["answeredAt"],
        subject_or_outcome: c["outcome"],
        summary: c["note"] ?? "",
      })),
    ].sort((a, b) =>
      ((b.date as string | undefined) ?? "").localeCompare((a.date as string | undefined) ?? ""),
    );

    const draftingHints: string[] = [];
    if (input.intent !== "") draftingHints.push(`Intent: ${input.intent}`);
    if (input.toneHints !== null && input.toneHints !== undefined && input.toneHints !== "") {
      draftingHints.push(`Tone: ${input.toneHints}`);
    }
    const lastReply = mailings.data.find(
      (m) => m["repliedAt"] !== undefined && m["repliedAt"] !== null,
    );
    if (lastReply !== undefined) {
      const repliedAt = String(lastReply["repliedAt"]);
      draftingHints.push(
        `Prospect replied to "${String(lastReply["subject"])}" on ${repliedAt.slice(0, 10)} — reference if appropriate.`,
      );
    }
    const lastCall = recentCalls[0];
    if (lastCall !== undefined) {
      const answeredAt = String(lastCall["answeredAt"]);
      const note = (lastCall["note"] as string | undefined) ?? "no note";
      draftingHints.push(`Last call (${answeredAt.slice(0, 10)}): ${note}`);
    }
    draftingHints.push("Personalize the opening; avoid generic 'I hope this finds you well'.");
    draftingHints.push("Sign off in the rep's voice; keep tone neutral if unknown.");

    const emails = prospect["emails"];
    const primaryEmail = Array.isArray(emails)
      ? (emails[0] as string | undefined)
      : (emails as string | undefined);

    return {
      prospect: {
        id: prospect["id"],
        name: nameFromParts(prospect["firstName"], prospect["lastName"]),
        title: prospect["title"],
        email: primaryEmail,
        accountName: prospect["accountName"],
        accountIndustry: prospect["accountIndustry"],
        stageName: prospect["stageName"],
        profileUrl: profileUrl("prospect", id),
      },
      recentInteractions,
      template:
        template !== null
          ? {
              id: template["id"],
              name: template["name"],
              subject: template["subject"],
              bodyHtml: template["bodyHtml"],
              bodyText: template["bodyText"],
            }
          : null,
      customFieldsRelevantToEmail: labelled.customFields ?? {},
      draftingHints,
      reminder:
        "This tool returns context only. The agent must compose the email and remind the user to copy it into Outreach.",
    };
  });
}

function nameFromParts(first: unknown, last: unknown): string {
  return `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
}
