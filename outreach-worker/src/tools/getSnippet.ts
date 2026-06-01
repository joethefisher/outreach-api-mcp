// getSnippet — full snippet body + owner.

import { profileUrl, runTool } from "./_helpers.js";

export interface GetSnippetInput {
  readonly snippetId: number;
}

const MAX_BODY = 5000;

export async function getSnippet(input: GetSnippetInput): Promise<string> {
  return runTool("getSnippet", input, async ({ client }) => {
    const id = input.snippetId;
    const snippet = await client.get("snippet", id, {
      includes: ["owner"],
      fields: {
        snippet: ["name", "bodyHtml", "shareType"],
        user: ["firstName", "lastName"],
      },
      flatten: { owner: ["firstName", "lastName"] },
    });

    const bodyHtml = (snippet["bodyHtml"] as string | undefined) ?? "";
    const ownerFirst = snippet["ownerFirstName"] as string | undefined;
    const ownerLast = snippet["ownerLastName"] as string | undefined;
    const ownerName =
      ownerFirst !== undefined || ownerLast !== undefined
        ? `${ownerFirst ?? ""} ${ownerLast ?? ""}`.trim()
        : undefined;

    return {
      snippet: {
        id: snippet["id"],
        name: snippet["name"],
        bodyHtml:
          bodyHtml.length > MAX_BODY ? `${bodyHtml.slice(0, MAX_BODY)}\n[...truncated]` : bodyHtml,
        shareType: snippet["shareType"] ?? null,
        ownerId: snippet["ownerId"],
        ownerName,
        profileUrl: profileUrl("snippet", id),
      },
    };
  });
}
