// getTeamRoster — active Outreach users (or all when activeOnly=false).

import { runTool } from "./_helpers.js";

export interface GetTeamRosterInput {
  readonly activeOnly?: boolean | null;
}

export async function getTeamRoster(input: GetTeamRosterInput): Promise<string> {
  return runTool("getTeamRoster", input, async ({ client }) => {
    const activeOnly = input.activeOnly !== false;

    const result = await client.list("user", {
      fields: { user: ["firstName", "lastName", "email", "title", "locked", "createdAt"] },
      pageSize: 500,
    });

    const users = result.data
      .filter((u) => (activeOnly ? u["locked"] !== true : true))
      .map((u) => ({
        id: u["id"],
        name: `${(u["firstName"] as string | undefined) ?? ""} ${(u["lastName"] as string | undefined) ?? ""}`.trim(),
        email: u["email"],
        title: u["title"],
        locked: u["locked"] === true,
        createdAt: u["createdAt"],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { users };
  });
}
