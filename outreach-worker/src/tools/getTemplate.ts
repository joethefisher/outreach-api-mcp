// getTemplate — full template content + sequence usage list.

import { OutreachApiException } from "../api/client.js";
import { relId } from "../api/filters.js";

import { profileUrl, runTool } from "./_helpers.js";

export interface GetTemplateInput {
  readonly templateId: number;
}

const MAX_BODY = 5000;

export async function getTemplate(input: GetTemplateInput): Promise<string> {
  return runTool("getTemplate", input, async ({ client }) => {
    const id = input.templateId;
    let usedInSequencesUnavailable = false;
    let sequenceTemplates: { data: readonly Record<string, unknown>[] } = { data: [] };

    const template = await client.get("template", id, {
      includes: ["owner"],
      fields: {
        template: [
          "name",
          "subject",
          "bodyHtml",
          "bodyText",
          "ccRecipients",
          "bccRecipients",
          "archived",
        ],
        user: ["firstName", "lastName"],
      },
      flatten: { owner: ["firstName", "lastName"] },
    });

    try {
      sequenceTemplates = await client.list("sequenceTemplate", {
        filters: { template: relId(id) },
        includes: ["sequenceStep.sequence"],
        fields: {
          sequenceTemplate: [],
          sequenceStep: ["order"],
          sequence: ["name"],
        },
        pageSize: 100,
      });
    } catch (e) {
      if (e instanceof OutreachApiException && e.envelope.error === "scopeMissing") {
        usedInSequencesUnavailable = true;
      } else {
        throw e;
      }
    }

    const bodyHtml = (template["bodyHtml"] as string | undefined) ?? "";
    const bodyText = (template["bodyText"] as string | undefined) ?? "";
    const ownerFirst = template["ownerFirstName"] as string | undefined;
    const ownerLast = template["ownerLastName"] as string | undefined;
    const ownerName =
      ownerFirst !== undefined || ownerLast !== undefined
        ? `${ownerFirst ?? ""} ${ownerLast ?? ""}`.trim()
        : undefined;

    return {
      template: {
        id: template["id"],
        name: template["name"],
        subject: template["subject"],
        bodyHtml:
          bodyHtml.length > MAX_BODY ? `${bodyHtml.slice(0, MAX_BODY)}\n[...truncated]` : bodyHtml,
        bodyText:
          bodyText.length > MAX_BODY ? `${bodyText.slice(0, MAX_BODY)}\n[...truncated]` : bodyText,
        ccRecipients: template["ccRecipients"] ?? [],
        bccRecipients: template["bccRecipients"] ?? [],
        archived: template["archived"],
        ownerId: template["ownerId"],
        ownerName,
        profileUrl: profileUrl("template", id),
      },
      usedInSequences: usedInSequencesUnavailable
        ? null
        : sequenceTemplates.data.map((st) => ({
            sequenceStepId: st["sequenceStepId"],
            sequenceId: st["sequenceStepSequenceId"] ?? null,
            sequenceName: st["sequenceStepSequenceName"] ?? null,
          })),
      ...(usedInSequencesUnavailable && {
        usedInSequencesNote:
          "sequenceTemplates.read scope not granted; usage list unavailable. Contact admin to widen OAuth scope.",
      }),
    };
  });
}
