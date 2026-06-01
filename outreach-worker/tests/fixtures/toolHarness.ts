// Tool-test harness — injects a StubOutreachClient + loaded schema cache.

import { StubOutreachClient, type StubData } from "./stubOutreachClient.js";
import { CustomFieldSchemaCache } from "../../src/schema/customFields.js";
import { resetToolContext, setToolContext } from "../../src/tools/_helpers.js";

export async function installToolContext(data: StubData = {}): Promise<StubOutreachClient> {
  const client = new StubOutreachClient(data);
  const schema = new CustomFieldSchemaCache(client);
  await schema.ensureLoaded();
  setToolContext({ client, schema });
  return client;
}

export function cleanupToolContext(): void {
  resetToolContext();
}

interface MaybeEnvelope {
  readonly error?: unknown;
  readonly message?: unknown;
}

/** Parse and assert that the tool returned a successful payload, not an envelope. */
export function parseSuccess(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as MaybeEnvelope & Record<string, unknown>;
  if (typeof value.error === "string") {
    const message = typeof value.message === "string" ? value.message : "";
    throw new Error(`Expected success but got envelope: ${value.error} — ${message}`);
  }
  return value;
}

/** Parse and assert that the tool returned an error envelope. */
export function parseEnvelope(raw: string): {
  error: string;
  message: string;
  [k: string]: unknown;
} {
  const value = JSON.parse(raw) as MaybeEnvelope & Record<string, unknown>;
  if (typeof value.error !== "string") {
    throw new Error(`Expected envelope but got success: ${raw.slice(0, 200)}`);
  }
  return value as { error: string; message: string; [k: string]: unknown };
}
