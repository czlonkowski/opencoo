/**
 * Minimal Asana-like API surface (PR 24 / plan #115).
 *
 * The OutputAdapter consumes ONLY this method from an Asana
 * client. Use-case-tier tests inject a mock that fulfills
 * the shape; production wiring (PR 30 composition root) wraps
 * the real Asana SDK around this interface.
 *
 * Per orchestrator override: real Asana SDK NOT imported in
 * v0.1. The adapter package stays dependency-light (just
 * @opencoo/shared + zod); production wiring imports the SDK
 * + maps it to `AsanaLikeApi`.
 */
export interface AsanaCreateTaskArgs {
  /** Personal access token bytes. The OutputAdapter resolves
   *  this from the CredentialStore at write-time and passes
   *  it through. */
  readonly accessToken: Buffer;
  readonly projectGid: string;
  readonly title: string;
  readonly notes: string;
  readonly dueOn?: string;
  readonly assigneeGid?: string;
}

export interface AsanaCreateTaskResult {
  /** New task gid Asana assigned. */
  readonly gid: string;
  /** Optional permalink URL to the task in the Asana UI. */
  readonly permalinkUrl?: string;
}

/** Asana API failure — the production wrapper translates the
 *  Asana SDK's error into this shape so the adapter's
 *  classification logic keys on a portable structure. */
export interface AsanaApiHttpError {
  readonly kind: "http";
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly message: string;
}

export interface AsanaApiTransientError {
  readonly kind: "transient";
  readonly message: string;
}

export type AsanaApiError =
  | AsanaApiHttpError
  | AsanaApiTransientError;

export interface AsanaLikeApi {
  createTask(args: AsanaCreateTaskArgs): Promise<AsanaCreateTaskResult>;
}
