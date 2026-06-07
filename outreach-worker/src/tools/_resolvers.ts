// Two-step lookup helpers.
//
// Outreach deprecated `filter[relationship][attribute]=value` in May 2023.
// To filter prospects by company name, we first resolve the name to account
// IDs, then filter the prospect query by account ID. Same pattern for owners
// and stages.
//
// Each resolver:
//   - returns []      → caller surfaces noResults
//   - returns [id]    → caller proceeds with that single ID
//   - returns [..>5]  → caller surfaces ambiguousMatch
//
// All resolvers are case-insensitive substring matches on the name fields.

import type { OutreachClient } from "../api/client.js";

import { paginateList } from "./_helpers.js";

export interface NamedMatch {
  readonly id: number;
  readonly label: string;
  readonly hint?: string;
}

/** Resolve an account name to up to 20 matches. */
export async function resolveAccountByName(
  client: OutreachClient,
  name: string,
): Promise<readonly NamedMatch[]> {
  const trimmed = name.trim();
  if (trimmed === "") return [];
  // Outreach's `name` filter is exact-match. Try exact first, then broaden to
  // a client-side substring scan if nothing matched.
  const exact = await client.list<{
    id: number;
    name: string;
    domain?: string;
  }>("account", {
    filters: { name: trimmed },
    fields: { account: ["name", "domain"] },
    pageSize: 20,
  });
  if (exact.data.length > 0) {
    return exact.data.map((a) =>
      a.domain !== undefined
        ? { id: a.id, label: a.name, hint: a.domain }
        : { id: a.id, label: a.name },
    );
  }
  // COR-07: paginate the substring scan instead of capping at one
  // 200-row page. Up to 10 pages × 200 = 2000 accounts considered before
  // we give up — far above any reasonable org size.
  const broad = await paginateList<{
    id: number;
    name: string;
    domain?: string;
  }>(client, "account", {
    fields: { account: ["name", "domain"] },
    pageSize: 200,
    maxPages: 10,
  });
  const lower = trimmed.toLowerCase();
  return broad.data
    .filter((a) => a.name.toLowerCase().includes(lower))
    .slice(0, 20)
    .map((a) =>
      a.domain !== undefined
        ? { id: a.id, label: a.name, hint: a.domain }
        : { id: a.id, label: a.name },
    );
}

/** Resolve a user (rep) by name or email to up to 20 matches. Skips locked users. */
export async function resolveUserByName(
  client: OutreachClient,
  query: string,
): Promise<readonly NamedMatch[]> {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return [];
  // COR-07: paginate the user scan. Pre-fix the 500-row cap meant orgs
  // with seat counts above 500 lost rep lookups beyond the first page —
  // searchProspects(ownerName=…) would return noResults for a real
  // person. Up to 10 pages × 500 = 5000 users.
  const broad = await paginateList<{
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
    title?: string;
    locked?: boolean;
  }>(client, "user", {
    fields: { user: ["firstName", "lastName", "email", "title", "locked"] },
    pageSize: 500,
    maxPages: 10,
  });
  return broad.data
    .filter((u) => {
      if (u.locked === true) return false;
      const fullName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase();
      const email = (u.email ?? "").toLowerCase();
      return fullName.includes(trimmed) || email.includes(trimmed);
    })
    .slice(0, 20)
    .map((u): NamedMatch => {
      const label = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
      return u.email !== undefined && u.email !== ""
        ? { id: u.id, label, hint: u.email }
        : { id: u.id, label };
    });
}

/** Resolve a stage name (case-insensitive substring match). */
export async function resolveStageByName(
  client: OutreachClient,
  name: string,
): Promise<readonly NamedMatch[]> {
  const trimmed = name.trim();
  if (trimmed === "") return [];
  // COR-07: paginate stage scan. Orgs with deep custom-stage taxonomies
  // (more than 500 stages across pipelines) previously lost matches
  // beyond the first page.
  const all = await paginateList<{ id: number; name: string }>(client, "stage", {
    fields: { stage: ["name"] },
    pageSize: 500,
    maxPages: 5,
  });
  const lower = trimmed.toLowerCase();
  return all.data
    .filter((s) => s.name.toLowerCase().includes(lower))
    .slice(0, 20)
    .map((s) => ({ id: s.id, label: s.name }));
}
