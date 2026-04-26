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
