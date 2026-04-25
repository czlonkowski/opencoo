/**
 * `OutputAdapter` — port for adapters that DELIVER opencoo
 * payloads to external systems (Asana task, Slack message,
 * email, custom webhook). Architecture §10 OutputAdapter.
 *
 * # Naming note — distinct from `OutputChannelAdapter`
 *
 * This port (`OutputAdapter`) is the architectural concept
 * for "writes to external systems" — the surface concrete
 * adapter packages (PR 24 `@opencoo/output-asana`, future
 * Slack / email) implement.
 *
 * `OutputChannelAdapter` (engine-self-operating, PR 20 part A)
 * is a NARROWER, engine-internal port for delivering an
 * agent's JSON output post-LLM. It exists to enforce the
 * Q10 constraint that delivery is out-of-band (the LLM does
 * not have an `output_channel_deliver` tool).
 *
 * In v0.1 the two are decoupled — engine-self-operating's
 * `OutputChannelRegistry` calls `OutputChannelAdapter.deliver`,
 * which a future bridge package will fan out to one or more
 * `OutputAdapter.write` calls. They are NOT renamed because
 * they carry distinct constraints (Q10 binding enforcement
 * vs. generic write-to-external).
 *
 * # Shape
 *
 *   - `slug` — stable adapter-slug.
 *   - `payloadSchema: ZodType<TPayload>` — Zod schema
 *     declared `.strict()` so unknown fields fail closed
 *     before any external call. Enforced by the contract
 *     suite assertion 8 (payload-schema-rejects-extra-keys).
 *   - `credentialSchema` — JSON-Schema-shaped object the
 *     Management UI renders. Types: `string`, `boolean`,
 *     `string[]`, with `secret: true` flagging a field for
 *     CredentialStore-backed encryption.
 *   - `write(args)` — the single sanctioned write path. Throws
 *     `OutputAdapterError` (subclass) on any failure. v0.1
 *     deliberately ships ONLY write — no update, no delete.
 *     Sinks that need richer mutation patterns will negotiate
 *     when they land.
 */
import type { z } from "zod";

import type { CredentialStore } from "../credential-store/index.js";
import type { CredentialId } from "../db/brands.js";

/** Bare-bones JSON-Schema subset the Management UI renders.
 *  Keep it narrow on purpose — the broader json-schema lands
 *  when the UI surfaces config nesting. */
export interface OutputCredentialField {
  readonly type: "string" | "boolean" | "string[]";
  readonly description?: string;
  /** Marks a string field for CredentialStore-backed
   *  encryption. The UI displays it masked, persists by id. */
  readonly secret?: boolean;
}

export interface OutputCredentialSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, OutputCredentialField>>;
  readonly required?: readonly string[];
}

export interface OutputWriteArgs<TPayload> {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  readonly payload: TPayload;
}

/** Returned by `write()` on success. The `externalId` is the
 *  source system's identifier for the new resource (Asana
 *  task gid, Slack ts, etc.). Recorded by the engine for
 *  cross-referencing back to the source from heartbeat /
 *  lint output. */
export interface OutputWriteResult {
  readonly externalId: string;
  /** Optional human-readable URL for the new resource. The
   *  engine renders this in the Review Dashboard. */
  readonly externalUrl?: string;
}

export interface OutputAdapter<TPayload> {
  readonly slug: string;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly credentialSchema: OutputCredentialSchema;
  write(args: OutputWriteArgs<TPayload>): Promise<OutputWriteResult>;
}
