/**
 * Contract tier — runs the shared suite against a REAL Docling sidecar.
 *
 * Gated on `DOCLING_URL`: absent → the entire suite is skipped (CI
 * default). Operators running a local Docling (docker compose up) can
 * export the URL and exercise the same assertion matrix end-to-end:
 *
 *     DOCLING_URL=http://localhost:5001 pnpm --filter @opencoo/converter-docling test
 *
 * The file loads real fixture bytes lazily so the byte-read doesn't
 * happen during skipped runs. Fixtures come from the same
 * `tests/fixtures/real/*` directory; if a fixture is missing we let
 * the file read error bubble — that's a harness misconfiguration, not
 * a product defect.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { documentConverterContract } from "@opencoo/shared/adapter-contract-tests/document-converter";

import { converterDocling, DoclingHttpClient } from "../src/index.js";
import type { DocumentConverterFixtures } from "@opencoo/shared/adapter-contract-tests/document-converter";

const DOCLING_URL = process.env.DOCLING_URL;
const HAS_DOCLING = DOCLING_URL !== undefined && DOCLING_URL.length > 0;

// Resolve fixtures relative to this file so the test can run from any cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_FIXTURES_DIR = path.join(__dirname, "fixtures", "real");

function loadRealBytes(name: string): Buffer {
  return fs.readFileSync(path.join(REAL_FIXTURES_DIR, name));
}

/**
 * For the contract tier we cannot pre-seed responses — the real
 * Docling will produce whatever it produces. The factory therefore
 * ignores the `canned` parameter and wires the live client.
 *
 * The shared contract tolerates this shape because every positive
 * assertion is structural ("markdown contains X", "no <script> tag",
 * "degraded===true for zero-pipes XLSX") — we're not asserting a
 * specific byte-for-byte Markdown. The fixture MUST be crafted so its
 * structural signals are real (e.g. the XLSX fixture must actually
 * contain data that Docling won't table-serialise).
 */
describe.runIf(HAS_DOCLING)("converter-docling — real Docling sidecar", () => {
  // describe.runIf skips at the describe level when HAS_DOCLING is
  // false, so this `it` and the fixtures below never load without the
  // env var present.
  it("delegates to shared documentConverterContract — run under DOCLING_URL", () => {
    // Intentionally empty — the real suite is registered at module
    // load below via `documentConverterContract(...)`. This `it` only
    // exists to give the runner something to report as "passed" so
    // operators confirm the URL was seen.
    expect(HAS_DOCLING).toBe(true);
  });
});

// Register the shared suite at module load if DOCLING_URL is set. The
// inner describes inherit the `runIf` gate because every `it` inside
// would fail without the sidecar — the shared contract's own calls
// resolve to the live `DoclingHttpClient` when we reach them.
if (HAS_DOCLING) {
  const url = DOCLING_URL as string;
  const fixtures: DocumentConverterFixtures = {
    happyPath: {
      filename: "strategy.pdf",
      mimeType: "application/pdf",
      bytes: loadRealBytes("strategy.pdf"),
      expectedMarkdownIncludes: "Fundamentals",
      clientResponse: { markdown: "" }, // ignored — real client is live
    },
    xlsxNoPipes: {
      filename: "figures-no-table.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: loadRealBytes("figures-no-table.xlsx"),
      clientResponse: { markdown: "" },
    },
    pptxNoHeadings: {
      filename: "deck-no-titles.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: loadRealBytes("deck-no-titles.pptx"),
      clientResponse: { markdown: "" },
    },
    htmlHostile: {
      filename: "hostile.html",
      mimeType: "text/html",
      bytes: loadRealBytes("hostile.html"),
      clientResponse: { markdown: "" },
    },
    malformed: {
      filename: "corrupted.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    },
  };

  documentConverterContract(
    () => converterDocling({ client: new DoclingHttpClient({ url }) }),
    fixtures,
    {
      expectedSlug: "converter-docling",
      expectedMimeTypes: [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/html",
      ],
    },
  );
}
