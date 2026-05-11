/**
 * Real `googleapis@^144` Drive client wrapped to the
 * `DriveLikeApi` surface (PR-Z1, phase-a appendix #12).
 *
 * Why this file exists. The adapter package was originally
 * shipped with a mock-only client (`makeMockDrive`) and a
 * "production wiring lands at the composition root" promise
 * (see `drive-api.ts` header). The first real partner cutover
 * tripped over the unfulfilled promise — the production-side
 * `makeDrive` factory in `packages/cli/src/provision/production-composition.ts`
 * still threw `"drive: production makeDrive not wired in v0.1"`,
 * so binding a Drive folder via the UI provisioned cleanly but
 * scanning it failed at the first call. Z1 closes that gap by
 * wrapping the official Google SDK to the narrow shape the
 * adapter consumes.
 *
 * Boundary. The adapter calls only three methods on any Drive
 * client (see `DriveLikeApi` in `drive-api.ts`):
 *
 *   - `getStartPageToken()` — bootstrap the cursor for the
 *     first scan.
 *   - `listChanges({ pageToken, folderId, mimeTypes })` — pull
 *     the next change page.
 *   - `exportAsBytes({ fileId, mimeType })` — fetch a single
 *     file's bytes.
 *
 * This module maps each to the real Drive REST surface and
 * returns Buffers — no streaming, no batching, no sub-typing.
 * If a future scenario needs richer Drive features (resumable
 * uploads, partial responses, change-watcher webhooks), they
 * land as adapter-specific code and stay invisible to this
 * boundary.
 *
 * THREAT-MODEL alignment.
 *
 *   - The factory consumes a service-account JSON
 *     (`{ client_email, private_key, ... }`) decoded from the
 *     `Buffer` plaintext that the CredentialStore returns. The
 *     SDK uses it to mint short-lived bearer tokens via
 *     `google-auth-library`'s `JWT` class — the canonical
 *     service-account auth pattern.
 *   - Scope is locked to `drive.readonly`. opencoo never
 *     mutates Drive content. Read-only is also defense in
 *     depth: a leaked token can't be used to delete partner
 *     files.
 *   - We do NOT use OAuth2 client flows here — those would
 *     require a refresh-token-storage scheme distinct from the
 *     CredentialStore and a redirect handler the engine
 *     intentionally doesn't ship.
 *   - The `parseServiceAccountJson` helper validates the two
 *     required fields and throws a typed error on bad input.
 *     We deliberately avoid pulling `zod` into this module —
 *     a 12-line hand-rolled parser is cheaper than the bundle
 *     hit and the errors it produces are equally actionable.
 */
import { google } from "googleapis";
import { JWT } from "google-auth-library";

import type {
  DriveChangeEntry,
  DriveExportArgs,
  DriveLikeApi,
  DriveListChangesArgs,
  DriveListChangesResult,
} from "./drive-api.js";

/**
 * Minimum subset of the Google service-account key JSON that
 * opencoo cares about. The real key file carries 7+ fields
 * (`type`, `project_id`, `private_key_id`, …); the others are
 * ignored — `JWT` only needs the email + private key.
 */
export interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * Read-only scope. Opencoo never mutates Drive content; the
 * SDK enforces the scope when minting the bearer token.
 */
const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/** Hint Drive prefer markdown when exporting Google Docs.
 *  Drive accepts `text/markdown` as of 2024; if a workspace
 *  has it disabled we fall back to plain text on a per-call
 *  basis — see `exportAsBytes`. */
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const MARKDOWN_MIME = "text/markdown";
const PLAIN_TEXT_MIME = "text/plain";

/**
 * Default page size for `listChanges`. Drive's API max is
 * 1000; defaulting to 100 keeps individual responses small
 * (matches the design-partner PoC's polling cadence — 4-hour
 * scans on small folders). Adapters that want a larger page
 * pass a different value through the (currently absent)
 * binding-config knob; the real-API test pins the default.
 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Defensive parse of the service-account JSON. Returns the
 * minimal `ServiceAccountKey` shape; throws a typed Error on
 * any structural problem so the operator sees a clear message
 * rather than a Drive 401 buried five frames deep.
 */
export function parseServiceAccountJson(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `drive: service-account JSON is not valid JSON (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "drive: service-account JSON must be an object with client_email + private_key",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const email = obj["client_email"];
  const key = obj["private_key"];
  if (typeof email !== "string" || email.length === 0) {
    throw new Error(
      "drive: service-account JSON missing required field 'client_email'",
    );
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      "drive: service-account JSON missing required field 'private_key'",
    );
  }
  return { client_email: email, private_key: key };
}

/**
 * Build the production `DriveLikeApi` from a parsed
 * service-account key. Each instance owns its own `JWT` —
 * tokens are cached inside the SDK, so reusing the returned
 * `DriveLikeApi` across scans is the cheap path.
 *
 * The shape is deliberately NOT a class — the adapter
 * consumes the interface, and a plain object closes over the
 * `drive` handle without giving callers a subclassing knob.
 */
export function createGoogleDriveApi(
  credentials: ServiceAccountKey,
): DriveLikeApi {
  const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [DRIVE_READONLY_SCOPE],
  });
  const drive = google.drive({ version: "v3", auth });

  return {
    async getStartPageToken(): Promise<string> {
      const response = await drive.changes.getStartPageToken({});
      const token = response.data.startPageToken;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error(
          "drive: getStartPageToken returned empty startPageToken",
        );
      }
      return token;
    },

    async listChanges(
      args: DriveListChangesArgs,
    ): Promise<DriveListChangesResult> {
      // The Drive API's `q` parameter doesn't apply to the
      // changes feed — it filters `files.list`, not
      // `changes.list`. The adapter post-filters by folderId
      // already (defense-in-depth in `adapter.ts`); we apply
      // the same per-mime-type narrowing here against
      // `file.mimeType` returned in the change payload.
      const response = await drive.changes.list({
        pageToken: args.pageToken,
        pageSize: DEFAULT_PAGE_SIZE,
        // Include modifiedTime + mimeType + parents so the
        // adapter can dedupe + folder-filter without a second
        // round trip per change.
        fields:
          "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,modifiedTime,mimeType,parents))",
        // Default `restrictToMyDrive=false` lets shared-drive
        // scenarios work; v0.1 partners have lived in My Drive
        // so far, but the SDK default is the safer floor.
      });
      const data = response.data;

      const changes: DriveChangeEntry[] = [];
      for (const change of data.changes ?? []) {
        const fileId = change.fileId;
        if (typeof fileId !== "string" || fileId.length === 0) continue;

        // Removed events flow through with a missing `file`
        // payload — emit them so the adapter's `removed` filter
        // sees them (the adapter then drops them; the API
        // honors the contract by surfacing the event).
        if (change.removed === true) {
          changes.push({
            fileId,
            revision: "",
            mimeType: "",
            removed: true,
          });
          continue;
        }

        const file = change.file;
        if (file === null || file === undefined) continue;
        const mimeType = file.mimeType;
        if (typeof mimeType !== "string") continue;
        if (!args.mimeTypes.includes(mimeType)) continue;

        // Folder scoping: Drive returns `parents: [folderId,…]`
        // when the file lives under one. The adapter ALSO
        // filters by folderId in `adapter.ts`, but applying
        // it here keeps the surface aligned with the mock's
        // `folderId` filtering and trims the response we
        // emit upstream.
        const parents = file.parents ?? [];
        if (parents.length > 0 && !parents.includes(args.folderId)) continue;

        changes.push({
          fileId,
          revision: file.modifiedTime ?? "",
          mimeType,
          removed: false,
        });
      }

      // Drive returns `nextPageToken` while paginating, then
      // `newStartPageToken` on the final page. The adapter's
      // contract is "always return a token to persist", so we
      // pick whichever is present (preferring nextPageToken
      // when both are absent we fall back to the input token,
      // matching the mock's monotonic-counter behavior).
      const nextPageToken =
        data.nextPageToken ?? data.newStartPageToken ?? args.pageToken;

      return {
        changes,
        nextPageToken,
      };
    },

    async exportAsBytes(args: DriveExportArgs): Promise<Buffer> {
      // Google-native types (Docs, Sheets, Slides, Forms,
      // Drawings) require the `files.export` endpoint with a
      // target mime type. Everything else (PDF, plain text,
      // images, etc.) flows through `files.get?alt=media`.
      if (args.mimeType === GOOGLE_DOC_MIME) {
        // Prefer markdown — Drive added it in 2024 and the
        // wiki compiler likes the lighter normalization step.
        // If the workspace has markdown export disabled the
        // export call returns a 400; fall back to plain text
        // so the adapter still gets bytes.
        try {
          const response = await drive.files.export(
            { fileId: args.fileId, mimeType: MARKDOWN_MIME },
            { responseType: "arraybuffer" },
          );
          return arrayBufferDataToBuffer(response.data);
        } catch (err) {
          // Tighten the fallback to the documented "format
          // unavailable" failure mode. Any other error
          // (auth, network, 5xx) bubbles unchanged.
          if (!isMarkdownExportUnavailable(err)) throw err;
          const response = await drive.files.export(
            { fileId: args.fileId, mimeType: PLAIN_TEXT_MIME },
            { responseType: "arraybuffer" },
          );
          return arrayBufferDataToBuffer(response.data);
        }
      }

      const response = await drive.files.get(
        { fileId: args.fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      return arrayBufferDataToBuffer(response.data);
    },
  };
}

/** googleapis returns `unknown` for `responseType: 'arraybuffer'`
 *  bodies (the SDK's typing is generic). Coerce defensively —
 *  Buffer.from accepts both ArrayBuffer and Buffer-already
 *  inputs without copying twice. */
function arrayBufferDataToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (
    data !== null &&
    typeof data === "object" &&
    "byteLength" in data &&
    "buffer" in data
  ) {
    // ArrayBufferView (Uint8Array, etc.) — Buffer.from
    // accepts a typed-array directly.
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error(
    "drive: export response was not an ArrayBuffer / Buffer payload",
  );
}

/** Detects the documented "this file's mime type doesn't
 *  support the requested export format" error so we can fall
 *  back to text/plain. Drive surfaces this as a 400 with
 *  `code: 400` on the `GaxiosError` shape. */
function isMarkdownExportUnavailable(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const obj = err as Record<string, unknown>;
  const code = obj["code"];
  // GaxiosError uses numeric `code` for HTTP status; fall back
  // to `status` for SDK versions that surface it differently.
  if (code === 400 || code === "400") return true;
  const status = obj["status"];
  if (status === 400) return true;
  return false;
}
