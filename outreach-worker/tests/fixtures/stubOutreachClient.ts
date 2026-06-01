// Stub OutreachClient for tool-layer integration tests.
//
// Per-resource fixtures the tool dispatches to. Each test seeds the
// resources it needs and asserts on the JSON-string the tool returns.

import type {
  GetOptions,
  ListOptions,
  ListResult,
  OutreachClient,
  OutreachUser,
} from "../../src/api/client.js";
import type { FilterMap } from "../../src/api/filters.js";

export interface StubData {
  readonly list?: Record<string, readonly Record<string, unknown>[]>;
  readonly get?: Record<string, Record<number, Record<string, unknown>>>;
  readonly count?: Record<string, number>;
  readonly listUsers?: readonly OutreachUser[];
  readonly fetchTypes?: unknown;
}

export class StubOutreachClient implements OutreachClient {
  public listCalls: { resource: string; options?: ListOptions }[] = [];
  public getCalls: { resource: string; id: number | string; options?: GetOptions }[] = [];
  public countCalls: { resource: string; filters?: FilterMap }[] = [];

  constructor(private readonly data: StubData = {}) {}

  list<T = Record<string, unknown>>(
    resource: string,
    options: ListOptions = {},
  ): Promise<ListResult<T>> {
    this.listCalls.push({ resource, options });
    const rows = (this.data.list?.[resource] ?? []) as readonly T[];
    return Promise.resolve({ data: rows, nextCursor: null });
  }

  get<T = Record<string, unknown>>(
    resource: string,
    id: number | string,
    options: GetOptions = {},
  ): Promise<T> {
    this.getCalls.push({ resource, id, options });
    const record = this.data.get?.[resource]?.[Number(id)];
    if (record === undefined) {
      return Promise.reject(
        new Error(`StubOutreachClient: no fixture for ${resource}/${String(id)}`),
      );
    }
    return Promise.resolve(record as T);
  }

  count(
    resource: string,
    filters?: FilterMap,
  ): Promise<{ readonly count: number; readonly truncated: boolean }> {
    this.countCalls.push({ resource, ...(filters !== undefined && { filters }) });
    const count = this.data.count?.[resource] ?? 0;
    return Promise.resolve({ count, truncated: false });
  }

  listUsers(): Promise<readonly OutreachUser[]> {
    return Promise.resolve(this.data.listUsers ?? []);
  }

  fetchTypes(): Promise<unknown> {
    return Promise.resolve(this.data.fetchTypes ?? { data: [] });
  }
}
