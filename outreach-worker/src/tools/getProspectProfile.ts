// getProspectProfile — full 360 view of a prospect (parallel fan-out).

import { range, relId } from "../api/filters.js";

import { daysAgoISO, optionalFetch, profileUrl, runTool } from "./_helpers.js";

export interface GetProspectProfileInput {
  readonly prospectId: number;
  readonly includeMailings?: boolean | null;
  readonly includeCalls?: boolean | null;
  readonly includeTasks?: boolean | null;
  readonly includeOpportunities?: boolean | null;
  readonly includeCustomFields?: boolean | null;
}

export async function getProspectProfile(input: GetProspectProfileInput): Promise<string> {
  return runTool("getProspectProfile", input, async ({ client, schema }) => {
    const id = input.prospectId;
    const includeMailings = input.includeMailings !== false;
    const includeCalls = input.includeCalls !== false;
    const includeTasks = input.includeTasks !== false;
    const includeOpportunities = input.includeOpportunities !== false;
    const includeCustomFields = input.includeCustomFields !== false;
    const since = daysAgoISO(30);

    const emptyPage: { data: readonly Record<string, unknown>[]; nextCursor: null } = {
      data: [],
      nextCursor: null,
    };
    const emptyPagePromise = Promise.resolve(emptyPage);

    // AVL-03 / NEW-8: each optional section is wrapped via the shared
    // `optionalFetch` helper. Domain failures (OutreachApiException,
    // AuthError) degrade into `unavailableSections`; programmer mistakes
    // propagate. The core prospect fetch stays hard.
    const unavailableSections: string[] = [];
    const optional = <T>(p: Promise<T>, label: string, fallback: T): Promise<T> =>
      optionalFetch(p, label, fallback, unavailableSections);

    const [prospect, sequenceStates, mailings, calls, tasks, opportunities] = await Promise.all([
      client.get("prospect", id, {
        includes: ["account.owner", "owner"],
        fields: {
          prospect: [
            "firstName",
            "lastName",
            "title",
            "emails",
            "linkedInUrl",
            "timeZone",
            "engagedScore",
            "engagedAt",
            "openCount",
            "clickCount",
            "replyCount",
            "stageName",
            "updatedAt",
            "custom1",
            "custom2",
            "custom3",
            "custom4",
            "custom5",
          ],
          account: [
            "name",
            "domain",
            "industry",
            "numberOfEmployees",
            "custom1",
            "custom2",
            "custom3",
          ],
          user: ["firstName", "lastName", "email"],
        },
        flatten: {
          account: ["name", "domain", "industry", "numberOfEmployees"],
          owner: ["firstName", "lastName", "email"],
        },
      }),
      optional(
        client.list("sequenceState", {
          filters: { prospect: relId(id), state: ["active", "paused", "pending"] },
          includes: ["sequence"],
          fields: {
            sequenceState: ["state", "createdAt", "stateChangedAt", "activeAt"],
            sequence: ["name"],
          },
          flatten: { sequence: ["name"] },
          pageSize: 50,
        }),
        "activeSequences",
        emptyPage,
      ),
      includeMailings
        ? optional(
            client.list("mailing", {
              filters: {
                prospect: relId(id),
                deliveredAt: range(`${since}T00:00:00Z`, new Date().toISOString()),
              },
              includes: ["sequence", "template"],
              fields: {
                mailing: [
                  "subject",
                  "state",
                  "deliveredAt",
                  "openedAt",
                  "clickedAt",
                  "repliedAt",
                  "bouncedAt",
                ],
                sequence: ["name"],
                template: ["name"],
              },
              flatten: { sequence: ["name"], template: ["name"] },
              pageSize: 50,
            }),
            "recentMailings",
            emptyPage,
          )
        : emptyPagePromise,
      includeCalls
        ? optional(
            client.list("call", {
              filters: { prospect: relId(id) },
              includes: ["user"],
              fields: {
                call: ["direction", "outcome", "answeredAt", "completedAt", "note"],
                user: ["firstName", "lastName"],
              },
              flatten: { user: ["firstName", "lastName"] },
              pageSize: 50,
            }),
            "recentCalls",
            emptyPage,
          )
        : emptyPagePromise,
      includeTasks
        ? optional(
            client.list("task", {
              filters: { prospect: relId(id), state: "incomplete" },
              includes: ["owner"],
              fields: {
                task: ["action", "state", "note", "dueAt", "createdAt"],
                user: ["firstName", "lastName"],
              },
              flatten: { owner: ["firstName", "lastName"] },
              pageSize: 50,
            }),
            "openTasks",
            emptyPage,
          )
        : emptyPagePromise,
      includeOpportunities
        ? optional(
            client.list("opportunity", {
              filters: { prospects: relId(id) },
              fields: {
                opportunity: [
                  "name",
                  "amount",
                  "closeDate",
                  "state",
                  "forecastCategory",
                  "probability",
                ],
              },
              pageSize: 50,
            }),
            "opportunities",
            emptyPage,
          )
        : emptyPagePromise,
    ]);

    const labelledProspect = includeCustomFields
      ? schema.applyLabelsTo("prospect", { ...prospect })
      : prospect;
    const labelledAccount = includeCustomFields
      ? schema.applyLabelsTo("account", {
          id: prospect["accountId"] as number,
          custom1: prospect["accountCustom1"],
          custom2: prospect["accountCustom2"],
          custom3: prospect["accountCustom3"],
        })
      : ({ id: prospect["accountId"] } as Record<string, unknown>);

    return {
      prospect: {
        id: prospect["id"],
        firstName: prospect["firstName"],
        lastName: prospect["lastName"],
        title: prospect["title"],
        emails: prospect["emails"],
        phoneNumbers: undefined,
        linkedInUrl: prospect["linkedInUrl"],
        timezone: prospect["timeZone"],
        engagedAt: prospect["engagedAt"],
        engagedScore: prospect["engagedScore"],
        openCount: prospect["openCount"],
        clickCount: prospect["clickCount"],
        replyCount: prospect["replyCount"],
        ...("customFields" in labelledProspect &&
          labelledProspect["customFields"] !== undefined && {
            customFields: labelledProspect["customFields"],
          }),
        profileUrl: profileUrl("prospect", id),
      },
      account:
        prospect["accountId"] !== undefined
          ? {
              id: prospect["accountId"],
              name: prospect["accountName"],
              domain: prospect["accountDomain"],
              industry: prospect["accountIndustry"],
              numberOfEmployees: prospect["accountEmployeeCount"],
              ...("customFields" in labelledAccount &&
                (labelledAccount as Record<string, unknown>)["customFields"] !== undefined && {
                  customFields: (labelledAccount as Record<string, unknown>)["customFields"],
                }),
              profileUrl: profileUrl("account", prospect["accountId"] as number),
            }
          : null,
      stage: prospect["stageName"] !== undefined ? { name: prospect["stageName"] } : null,
      owner:
        prospect["ownerId"] !== undefined
          ? {
              id: prospect["ownerId"],
              name: nameFromParts(prospect["ownerFirstName"], prospect["ownerLastName"]),
              email: prospect["ownerEmail"],
            }
          : null,
      activeSequences: sequenceStates.data.map((s) => ({
        sequenceStateId: s["id"],
        sequenceId: s["sequenceId"],
        sequenceName: s["sequenceName"],
        state: s["state"],
        currentStepNumber: undefined,
        enrolledAt: s["createdAt"],
      })),
      recentMailings: [...mailings.data]
        .sort((a, b) =>
          ((b["deliveredAt"] as string | undefined) ?? "").localeCompare(
            (a["deliveredAt"] as string | undefined) ?? "",
          ),
        )
        .map((m) => ({
          id: m["id"],
          subject: m["subject"],
          state: m["state"],
          deliveredAt: m["deliveredAt"],
          openedAt: m["openedAt"],
          clickedAt: m["clickedAt"],
          repliedAt: m["repliedAt"],
          sequenceName: m["sequenceName"],
          templateName: m["templateName"],
        })),
      recentCalls: [...calls.data]
        .sort((a, b) =>
          ((b["answeredAt"] as string | undefined) ?? "").localeCompare(
            (a["answeredAt"] as string | undefined) ?? "",
          ),
        )
        .map((c) => {
          const ans =
            typeof c["answeredAt"] === "string" ? new Date(c["answeredAt"]).getTime() : null;
          const comp =
            typeof c["completedAt"] === "string" ? new Date(c["completedAt"]).getTime() : null;
          const duration =
            ans !== null && comp !== null ? Math.round((comp - ans) / 1000) : undefined;
          return {
            id: c["id"],
            direction: c["direction"],
            outcome: c["outcome"],
            answeredAt: c["answeredAt"],
            duration,
            note: c["note"],
            userName: nameFromParts(c["userFirstName"], c["userLastName"]),
          };
        }),
      openTasks: tasks.data.map((t) => ({
        id: t["id"],
        action: t["action"],
        note: t["note"],
        dueAt: t["dueAt"],
        ownerName: nameFromParts(t["ownerFirstName"], t["ownerLastName"]),
      })),
      opportunities: opportunities.data.map((o) => ({
        id: o["id"],
        name: o["name"],
        forecastCategory: o["forecastCategory"],
        amount: o["amount"],
        closeDate: o["closeDate"],
        state: o["state"],
        probability: o["probability"],
      })),
      ...(unavailableSections.length > 0 && { unavailableSections }),
    };
  });
}

function nameFromParts(first: unknown, last: unknown): string | undefined {
  if (typeof first !== "string" && typeof last !== "string") return undefined;
  const combined =
    `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
  return combined === "" ? undefined : combined;
}
