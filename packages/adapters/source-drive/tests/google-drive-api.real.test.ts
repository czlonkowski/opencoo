/**
 * Real-API integration test for the Drive client wiring
 * (PR-Z1, phase-a appendix #12).
 *
 * Gating. This test only runs when both:
 *
 *   - `RUN_REAL_DRIVE=1` is set (parallel to the existing
 *     `RUN_REAL_PILOT=1` lane), AND
 *   - `RUN_REAL_DRIVE_SA_JSON` points to a readable file
 *     containing the service-account JSON.
 *
 * Without those, the file describes the suite but every test
 * inside is skipped with a `[skipped]` reason — vitest counts
 * the file as touched but no real work runs. This is the same
 * pattern PR-Q4's live-pilot tests use; it stays out of CI by
 * default and operators opt in deliberately with a fixture
 * service account.
 *
 * What it asserts. The three boundary methods that
 * `production-composition.ts` calls indirectly through the
 * adapter:
 *
 *   - `getStartPageToken` returns a non-empty string.
 *   - `listChanges` against the start token returns the result
 *     shape (we do NOT assert content count — the test folder
 *     might have a single file or thousands; we assert the
 *     shape).
 *   - `exportAsBytes` against a known test file id returns a
 *     non-empty Buffer in the expected mime branch.
 *
 * Operator setup. Drop the SA JSON at a local path NOT in the
 * repo, share the test folder + test doc with the SA email:
 *
 *   RUN_REAL_DRIVE=1 \
 *   RUN_REAL_DRIVE_SA_JSON=/abs/path/to/sa.json \
 *   RUN_REAL_DRIVE_FOLDER_ID=<folder-id> \
 *   RUN_REAL_DRIVE_DOC_ID=<google-doc-id> \
 *     pnpm --filter @opencoo/source-drive test
 *
 * The folder + doc env vars are required when the gate is on
 * — the test fails fast with a clear error if either is
 * missing. Service-account JSON file is read once at module
 * load.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createGoogleDriveApi,
  parseServiceAccountJson,
} from "../src/google-drive-api.js";

const GATE = process.env["RUN_REAL_DRIVE"] === "1";
const SA_PATH = process.env["RUN_REAL_DRIVE_SA_JSON"];
const FOLDER_ID = process.env["RUN_REAL_DRIVE_FOLDER_ID"];
const DOC_ID = process.env["RUN_REAL_DRIVE_DOC_ID"];

// Use describe.skipIf to keep the file observable in CI
// output (the suite name lists, with a "skipped" marker)
// without running anything. When the gate is on, the inner
// `beforeAll`-shaped checks fail loudly if a required env var
// is missing — that's the right failure mode (operator opted
// in but didn't finish setup).
describe.skipIf(!GATE)(
  "google-drive-api — RUN_REAL_DRIVE integration",
  () => {
    if (SA_PATH === undefined || SA_PATH.length === 0) {
      it("RUN_REAL_DRIVE=1 requires RUN_REAL_DRIVE_SA_JSON to point at the SA JSON file", () => {
        throw new Error(
          "RUN_REAL_DRIVE=1 set but RUN_REAL_DRIVE_SA_JSON is unset; either provide the path or unset RUN_REAL_DRIVE",
        );
      });
      return;
    }
    if (FOLDER_ID === undefined || FOLDER_ID.length === 0) {
      it("RUN_REAL_DRIVE=1 requires RUN_REAL_DRIVE_FOLDER_ID", () => {
        throw new Error(
          "RUN_REAL_DRIVE=1 set but RUN_REAL_DRIVE_FOLDER_ID is unset; supply the test folder id",
        );
      });
      return;
    }
    if (DOC_ID === undefined || DOC_ID.length === 0) {
      it("RUN_REAL_DRIVE=1 requires RUN_REAL_DRIVE_DOC_ID", () => {
        throw new Error(
          "RUN_REAL_DRIVE=1 set but RUN_REAL_DRIVE_DOC_ID is unset; supply the test doc id",
        );
      });
      return;
    }

    const raw = readFileSync(SA_PATH, "utf8");
    const sa = parseServiceAccountJson(raw);
    const api = createGoogleDriveApi(sa);

    it("getStartPageToken returns a non-empty string", async () => {
      const token = await api.getStartPageToken();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("listChanges from the start token returns a result with nextPageToken + iterable changes", async () => {
      const start = await api.getStartPageToken();
      const result = await api.listChanges({
        pageToken: start,
        folderId: FOLDER_ID,
        mimeTypes: [
          "application/vnd.google-apps.document",
          "application/pdf",
          "text/plain",
        ],
      });
      expect(typeof result.nextPageToken).toBe("string");
      expect(result.nextPageToken.length).toBeGreaterThan(0);
      expect(Array.isArray(result.changes)).toBe(true);
      // Don't assert >= 1 — the change-feed semantics mean a
      // freshly-pulled start token returns 0 changes until
      // something mutates. The shape pin is what we want.
    });

    it("exportAsBytes on the fixture Google Doc returns a non-empty Buffer", async () => {
      const bytes = await api.exportAsBytes({
        fileId: DOC_ID,
        mimeType: "application/vnd.google-apps.document",
      });
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(0);
    });
  },
);

// Always-present sentinel so vitest doesn't mark the file as
// "no tests" when the gate is off. This is the pattern from
// PR-Q4's live-pilot suite.
describe.skipIf(GATE)("google-drive-api — RUN_REAL_DRIVE skipped", () => {
  it("set RUN_REAL_DRIVE=1 + RUN_REAL_DRIVE_SA_JSON to enable", () => {
    expect(GATE).toBe(false);
  });
});
