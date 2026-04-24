/**
 * Shape-lock for `@opencoo/shared/adapter-contract-tests/document-converter`.
 *
 * The module is a reusable contract suite — every adapter that implements
 * `DocumentConverterAdapter` gets the same 9-assertion matrix by
 * calling `documentConverterContract(makeAdapter, fixtures)`. These
 * tests do NOT invoke the generated suite (that's done in each
 * adapter's own tests); they only verify that the contract module
 * exports the shape every consumer package is going to import.
 */
import { describe, it, expect } from "vitest";

import {
  documentConverterContract,
  ConversionError,
  type DocumentConverterAdapter,
  type ConversionResult,
  type DocumentConverterFixtures,
} from "../src/adapter-contract-tests/document-converter.js";

describe("adapter-contract-tests/document-converter — module shape", () => {
  it("exports documentConverterContract as a function", () => {
    expect(typeof documentConverterContract).toBe("function");
  });

  it("exports ConversionError extending OpencooError with errorClass='validation'", () => {
    const err = new ConversionError("bad", "malformed-input");
    expect(err).toBeInstanceOf(Error);
    expect(err.errorClass).toBe("validation");
    expect(err.reason).toBe("malformed-input");
    expect(err.name).toBe("ConversionError");
  });

  it("ConversionError preserves cause via OpencooError options", () => {
    const cause = new Error("downstream");
    const err = new ConversionError("wrap", "sidecar-unreachable", { cause });
    expect(err.cause).toBe(cause);
    expect(err.reason).toBe("sidecar-unreachable");
  });

  it("ConversionError.reason accepts all three sanctioned discriminants", () => {
    const r1 = new ConversionError("a", "malformed-input").reason;
    const r2 = new ConversionError("b", "sidecar-unreachable").reason;
    const r3 = new ConversionError("c", "timeout").reason;
    expect([r1, r2, r3]).toEqual([
      "malformed-input",
      "sidecar-unreachable",
      "timeout",
    ]);
  });

  it("types compile — DocumentConverterAdapter, ConversionResult, DocumentConverterFixtures", () => {
    // A stub matching the exported interface must type-check. Any drift
    // in the interface (field renamed, new required field) breaks this
    // file and every adapter package at the same time.
    const stub: DocumentConverterAdapter = {
      slug: "test",
      mimeTypes: ["application/pdf"],
      async convert(args) {
        // Reference `args` so `noUnusedParameters` is satisfied; the
        // stub doesn't need to inspect its input — only to type-check
        // against the interface shape.
        const result: ConversionResult = {
          markdown: `# ${args.filename}`,
          structureSignals: {
            detectedTables: 0,
            gfmPipes: 0,
            detectedHeadings: 1,
          },
          degraded: false,
        };
        return result;
      },
    };
    // Minimal fixtures — the real adapters pass full canned data.
    const fixtures: DocumentConverterFixtures = {
      happyPath: {
        filename: "ok.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]),
        expectedMarkdownIncludes: "#",
        clientResponse: {
          markdown: "# ok\n",
        },
      },
      xlsxNoPipes: {
        filename: "data.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: Buffer.from([0]),
        clientResponse: { markdown: "sheet\n" },
      },
      pptxNoHeadings: {
        filename: "deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        bytes: Buffer.from([0]),
        clientResponse: { markdown: "slide body\n" },
      },
      htmlHostile: {
        filename: "page.html",
        mimeType: "text/html",
        bytes: Buffer.from("<html></html>"),
        clientResponse: {
          markdown:
            "# t\n<script>alert(1)</script>[x](javascript:alert(1))",
        },
      },
      malformed: {
        filename: "broken.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.from([0]),
      },
    };
    expect(stub.slug).toBe("test");
    expect(fixtures.happyPath.mimeType).toBe("application/pdf");
  });
});
