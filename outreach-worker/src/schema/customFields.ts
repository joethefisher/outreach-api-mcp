// Outreach custom field schema cache.
//
// On first access, fetches /api/v2/types via the OutreachClient and builds a
// per-resource map: customN → admin label. Provides:
//   - labelForField(resource, customN) → label or null
//   - fieldForLabel(resource, label) → customN or null
//   - applyLabelsTo(resource, normalizedRecord) — replaces customN keys with
//     admin labels, dropping null/empty values unless `keepNulls` is true.
//
// The cache lives for the lifetime of the MCP server process. If Outreach
// admins reconfigure custom fields mid-session, bouncing the server picks up
// the change.

import type { OutreachClient } from "../api/client.js";
import { logger } from "../logger.js";

interface CustomFieldDef {
  readonly label: string;
  readonly type: string;
}

interface ResourceSchema {
  readonly byField: Map<string, CustomFieldDef>;
  readonly byLabel: Map<string, string>;
}

export class CustomFieldSchemaCache {
  private readonly cache = new Map<string, ResourceSchema>();
  private loadedPromise: Promise<void> | null = null;
  private failed = false;

  constructor(private readonly client: OutreachClient) {}

  /**
   * Populate the cache on first call. Idempotent and concurrency-safe —
   * concurrent callers await the same fetch. On failure the cache enters a
   * "failed" state so further calls don't keep retrying; tools fall back to
   * raw customN keys.
   */
  async ensureLoaded(): Promise<void> {
    if (this.cache.size > 0 || this.failed) return;
    if (this.loadedPromise !== null) return this.loadedPromise;
    this.loadedPromise = this.load();
    try {
      await this.loadedPromise;
    } finally {
      this.loadedPromise = null;
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await this.client.fetchTypes();
      this.populateFrom(raw);
      logger.info("schema.cache.loaded", { resourceCount: this.cache.size });
    } catch (e) {
      logger.warn("schema.cache.load.failed", {
        message: e instanceof Error ? e.message : String(e),
      });
      this.failed = true;
    }
  }

  /**
   * Populate from the live `/api/v2/types` JSON:API document shape:
   *   { data: [
   *     { type: "Prospect", meta: { validations: { custom1: { label, type, ... } } } },
   *     ...
   *   ] }
   *
   * Also accepts the legacy fixture shape for backwards-compatible tests:
   *   { data: { prospect: { attributes: { customN: { label, type, ... } } } } }
   */
  private populateFrom(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const top = raw as { data?: unknown };
    if (top.data === undefined || top.data === null) return;

    if (Array.isArray(top.data)) {
      for (const entry of top.data) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as { type?: unknown; meta?: { validations?: unknown } };
        const resourceType = typeof e.type === "string" ? e.type.toLowerCase() : "";
        const validations = e.meta?.validations;
        if (resourceType === "" || typeof validations !== "object" || validations === null)
          continue;
        this.populateResource(resourceType, validations as Readonly<Record<string, unknown>>);
      }
      return;
    }

    if (typeof top.data === "object") {
      for (const [resourceType, body] of Object.entries(top.data as Record<string, unknown>)) {
        if (typeof body !== "object" || body === null) continue;
        const attrs = (body as { attributes?: unknown }).attributes;
        if (typeof attrs !== "object" || attrs === null) continue;
        this.populateResource(
          resourceType.toLowerCase(),
          attrs as Readonly<Record<string, unknown>>,
        );
      }
    }
  }

  private populateResource(
    resourceType: string,
    validations: Readonly<Record<string, unknown>>,
  ): void {
    const schema: ResourceSchema = { byField: new Map(), byLabel: new Map() };
    for (const [fieldName, def] of Object.entries(validations)) {
      if (!/^custom\d+$/i.test(fieldName)) continue;
      if (typeof def !== "object" || def === null) continue;
      const d = def as { label?: unknown; type?: unknown };
      if (typeof d.label !== "string" || d.label.length === 0) continue;
      const fieldDef: CustomFieldDef = {
        label: d.label,
        type: typeof d.type === "string" ? d.type : "string",
      };
      schema.byField.set(fieldName, fieldDef);
      schema.byLabel.set(d.label.toLowerCase(), fieldName);
    }
    if (schema.byField.size > 0) this.cache.set(resourceType, schema);
  }

  labelForField(resourceType: string, customN: string): string | null {
    return this.cache.get(resourceType)?.byField.get(customN)?.label ?? null;
  }

  fieldForLabel(resourceType: string, label: string): string | null {
    return this.cache.get(resourceType)?.byLabel.get(label.toLowerCase()) ?? null;
  }

  /**
   * Mutate `record` in place: replace every `customN` key with the admin
   * label, grouped under a `customFields` sub-object. Unmapped customN keys
   * are dropped (noise). Null/undefined/empty values are dropped unless
   * `keepNulls` is true.
   */
  applyLabelsTo<T extends Record<string, unknown>>(
    resourceType: string,
    record: T,
    options: { readonly keepNulls?: boolean } = {},
  ): T & { customFields?: Record<string, unknown> } {
    const customFields: Record<string, unknown> = {};
    const mut = record as Record<string, unknown>;
    const keysToRemove: string[] = [];
    for (const key of Object.keys(record)) {
      if (!key.startsWith("custom")) continue;
      const value = record[key];
      keysToRemove.push(key);
      const label = this.labelForField(resourceType, key);
      if (label === null) continue;
      const keepNulls = options.keepNulls === true;
      if (!keepNulls && (value === null || value === undefined || value === "")) continue;
      customFields[label] = value;
    }
    // Reflect.deleteProperty avoids the ts-eslint no-dynamic-delete rule and
    // is the standard idiom for removing dynamic keys.
    for (const key of keysToRemove) Reflect.deleteProperty(mut, key);
    if (Object.keys(customFields).length > 0) {
      mut["customFields"] = customFields;
    }
    return record;
  }

  isLoaded(): boolean {
    return this.cache.size > 0 && !this.failed;
  }
}

let singleton: CustomFieldSchemaCache | null = null;

export function getSchemaCache(client: OutreachClient): CustomFieldSchemaCache {
  singleton ??= new CustomFieldSchemaCache(client);
  return singleton;
}

export function resetSchemaCache(): void {
  singleton = null;
}
