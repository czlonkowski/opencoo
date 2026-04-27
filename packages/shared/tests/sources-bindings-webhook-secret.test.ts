/**
 * Migration 0007 — `sources_bindings.webhook_secret_credentials_id: uuid` (nullable).
 *
 * Webhook-mode SourceAdapters (asana, fireflies) need TWO encrypted
 * credentials per binding:
 *   - `credentials_id`               — auth credentials (PAT,
 *     API key) the adapter uses to fetch full content after a
 *     webhook fires.
 *   - `webhook_secret_credentials_id` — the HMAC signing
 *     secret the receiver verifies inbound webhooks against.
 *
 * Polling adapters leave `webhook_secret_credentials_id` NULL.
 *
 * The column is a uuid FK to `credentials.id` with `ON DELETE
 * RESTRICT` so a stray credential delete cannot orphan a live
 * binding's webhook verification.
 *
 * Phase-a appendix #2.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { sourcesBindings } from "../src/db/schema/index.js";

describe("sources_bindings.webhook_secret_credentials_id (phase-a appendix #2)", () => {
  it("exists as a column on the sources_bindings table", () => {
    const cols = getTableConfig(sourcesBindings).columns.map((c) => c.name);
    expect(cols).toContain("webhook_secret_credentials_id");
  });

  it("is nullable (polling adapters leave it null)", () => {
    const col = getTableConfig(sourcesBindings).columns.find(
      (c) => c.name === "webhook_secret_credentials_id",
    );
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });

  it("has uuid dataType (FK to credentials.id)", () => {
    const col = getTableConfig(sourcesBindings).columns.find(
      (c) => c.name === "webhook_secret_credentials_id",
    );
    // drizzle's uuid columns surface as `{ dataType: 'string',
    // columnType: 'PgUUID' }` — match on columnType for tightness.
    expect(col?.columnType).toBe("PgUUID");
  });

  it("references credentials(id) ON DELETE RESTRICT (FK preserved)", () => {
    const cfg = getTableConfig(sourcesBindings);
    // FK metadata is on cfg.foreignKeys; locate the one whose
    // local column matches.
    const fk = cfg.foreignKeys.find((f) =>
      f
        .reference()
        .columns.some((c) => c.name === "webhook_secret_credentials_id"),
    );
    expect(fk, "FK on webhook_secret_credentials_id missing").toBeDefined();
    expect(fk?.onDelete).toBe("restrict");
    // Foreign-side column is `credentials.id`.
    const fkRef = fk?.reference();
    expect(fkRef?.foreignColumns[0]?.name).toBe("id");
  });
});
