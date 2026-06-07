// getTeamRoster — active Outreach users (or all when activeOnly=false).

import { paginateList, runTool } from "./_helpers.js";

export interface GetTeamRosterInput {
  readonly activeOnly?: boolean | null;
}

export async function getTeamRoster(input: GetTeamRosterInput): Promise<string> {
  return runTool("getTeamRoster", input, async ({ client }) => {
    const activeOnly = input.activeOnly !== false;

    // COR-07: the prior single-page read capped silently at 500 users,
    // which meant orgs with a larger seat count had reps invisibly dropped
    // from the roster. Paginate up to 10 pages × 500 = 5000 users, with a
    // `truncated` flag surfaced when we hit the cap.
    const result = await paginateList(client, "user", {
      fields: { user: ["firstName", "lastName", "email", "title", "locked", "createdAt"] },
      pageSize: 500,
      maxPages: 10,
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

    return {
      users,
      truncated: result.truncated,
      ...(result.truncated && {
        note: "Roster larger than 5000 users; some entries omitted. Filter further (or paginate the source) if you need them all.",
      }),
    };
  });
}
