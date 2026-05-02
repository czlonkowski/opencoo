/**
 * Cross-route shared types (PR 29 / plan #131).
 */
export type Tab = "domains" | "sources" | "llmPolicy" | "prompts";

export interface Domain {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly class: string;
  readonly locale: string;
  readonly isAggregator: boolean;
}

export interface SourceBinding {
  readonly id: string;
  readonly domainSlug: string;
  readonly adapterSlug: string;
  readonly reviewMode: string;
  readonly enabled: boolean;
  readonly notes: string | null;
  /** Human-readable label: server-derived from notes or adapter→domain.
   *  A schema column for explicit name is a v0.2 enhancement. */
  readonly name: string;
  /** Server-computed 3-state health status, or null for neutral
   *  (newly-created binding with no events, or paused/disabled). */
  readonly status: "healthy" | "advisory" | "alert" | null;
  /** ISO timestamp of most-recent webhook event, or null. */
  readonly lastEventAt: string | null;
  /** Truncated + scrubbed error string, or null. Max 200 chars.
   *  THREAT-MODEL §3.6 invariant 11: no credential bytes. */
  readonly lastError: string | null;
}

export interface PromptManifestEntry {
  readonly name: string;
  readonly locales: ReadonlyArray<{ readonly locale: string; readonly version: string }>;
}

export interface SovereigntyDiffPreview {
  readonly diff: ReadonlyArray<{
    readonly path: string;
    readonly before: unknown;
    readonly after: unknown;
  }>;
  readonly token: string;
  readonly expiresAt: number;
}

/** Server response shape for `POST /api/admin/domains/:id/llm-policy/apply`.
 *  The `id` field mirrors the server's `{ ok: true, id }` payload
 *  shape verbatim; renaming on the wire is not done. */
export interface LlmPolicyApplyResult {
  readonly ok: true;
  readonly id: string;
}
