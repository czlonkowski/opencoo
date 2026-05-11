/**
 * `output_channels` — operator-managed delivery channels (PR-Z4,
 * phase-a appendix #12 wave-12 G5).
 *
 * One row per configured channel (e.g. "daily-report → Asana
 * project XYZ"). Bound by reference from
 * `agent_instances.output_channel_ids[]` (jsonb array of
 * `{adapter_slug, config}`); the engine's post-run hook reads
 * those bindings and dispatches via the `OutputChannelRegistry`
 * (architecture §10 OutputAdapter, THREAT-MODEL §3.5 Q10).
 *
 * Schema shape:
 *   - `adapter_slug` — text identifier of the OutputAdapter
 *     package (e.g. `'asana'`). NOT a FK — the registry is in
 *     code, not in Postgres.
 *   - `name`         — human-readable label the operator picks.
 *     `UNIQUE` per `adapter_slug` so the UI's binding picker can
 *     show stable identifiers.
 *   - `config`       — adapter-specific operational settings
 *     (e.g. Asana `{ project_gid }`). Validated against the
 *     adapter's payload schema at create/update time; persisted
 *     verbatim. NEVER credential bytes.
 *   - `credentials_id` — FK → `credentials.id`. The encrypted
 *     access-token blob the OutputAdapter reads at delivery time
 *     via the `CredentialStore`.
 *   - `enabled`      — operator soft-toggle. When false, the
 *     dispatcher's delivery hook skips the channel (logged).
 *
 * No FK exists from `agent_instances.output_channel_ids[]` →
 * `output_channels.id` (jsonb arrays can't have hard FKs in
 * Postgres without triggers). Dangling references are tolerated:
 * the dispatcher logs `output_channel.missing` and skips.
 *
 * THREAT-MODEL alignment:
 *   - §3.5 Q10 binding-enforcement: the registry cross-checks the
 *     agent's invocation against the instance's bindings BEFORE
 *     calling `OutputAdapter.write`. A prompt-injection on the
 *     agent cannot redirect delivery to a channel not on the
 *     instance's allow-list.
 *   - §3.6 invariant 11: credentials NEVER leak into `config`.
 *     The route validators reject submissions that put secret
 *     bytes in the config payload.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";
import { credentials } from "./credentials.js";

export const outputChannels = pgTable(
  "output_channels",
  {
    id: primaryKeyId(),
    adapterSlug: text("adapter_slug").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    /** FK to the encrypted credential record. Nullable so a
     *  channel can be created mid-flight with a placeholder if
     *  needed; the route validators enforce presence at create
     *  time (operator can't enable a channel without a credential).
     *  `ON DELETE RESTRICT` so a credential rotation must go
     *  through the channel-update path, not orphan the FK. */
    credentialsId: uuid("credentials_id").references(
      () => credentials.id,
      { onDelete: "restrict" },
    ),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("output_channels_adapter_slug_name_unique").on(
      t.adapterSlug,
      t.name,
    ),
  ],
);
