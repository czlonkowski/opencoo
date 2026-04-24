/**
 * Use-case tier — the contract suite driven by a `MockDoclingClient`.
 * Runs on every `pnpm test` with no external dependencies. The
 * companion `*.contract.test.ts` exercises the same suite against a
 * real Docling sidecar and is gated on `DOCLING_URL`.
 */
import { describe, it, expect } from "vitest";

import { documentConverterContract } from "@opencoo/shared/adapter-contract-tests/document-converter";

import { converterDocling } from "../src/index.js";
import { MockDoclingClient } from "../src/testing/mock-client.js";
import { fixtures } from "./fixtures/index.js";

documentConverterContract(
  (canned) =>
    converterDocling({ client: new MockDoclingClient(canned) }),
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

// Package-specific assertions — not part of the shared contract.
describe("converter-docling — package-local assertions", () => {
  it("passes the raw bytes + mimeType + filename through to the client unchanged", async () => {
    let captured:
      | { bytes: Buffer; mimeType: string; filename: string }
      | null = null;
    const spyClient = new MockDoclingClient(
      [
        {
          filename: "in.pdf",
          mimeType: "application/pdf",
          response: { markdown: "# ok\n" },
        },
      ],
      (args) => {
        captured = { bytes: args.bytes, mimeType: args.mimeType, filename: args.filename };
      },
    );
    const adapter = converterDocling({ client: spyClient });
    const bytes = Buffer.from("hello");
    await adapter.convert({ bytes, mimeType: "application/pdf", filename: "in.pdf" });
    expect(captured).not.toBeNull();
    expect(captured!.bytes.equals(bytes)).toBe(true);
    expect(captured!.mimeType).toBe("application/pdf");
    expect(captured!.filename).toBe("in.pdf");
  });
});
