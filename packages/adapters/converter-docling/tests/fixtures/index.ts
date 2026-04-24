// Synthetic fixtures for the converter-docling contract suite. We never
// ship real PDF/DOCX/XLSX bytes — the use-case tier runs through a
// MockDoclingClient, so the raw bytes only need to be non-empty
// Buffers the adapter forwards to the client; the canned response is
// what drives each assertion.
//
// The gated contract-tier (`converter-docling.contract.test.ts`) hits a
// real Docling sidecar and WILL need real bytes. That file lives next
// to this one but loads its own fixtures lazily.
import { Buffer } from "node:buffer";

import type { DocumentConverterFixtures } from "@opencoo/shared/adapter-contract-tests/document-converter";

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
const NON_EMPTY = Buffer.from([0]);

export const fixtures: DocumentConverterFixtures = {
  happyPath: {
    filename: "strategy.pdf",
    mimeType: "application/pdf",
    bytes: PDF_MAGIC,
    expectedMarkdownIncludes: "Fundamentals",
    clientResponse: {
      markdown: [
        "# Fundamentals",
        "",
        "A strategy document.",
        "",
        "| Col A | Col B |",
        "| ----- | ----- |",
        "| x     | y     |",
      ].join("\n"),
    },
  },
  xlsxNoPipes: {
    filename: "figures.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: NON_EMPTY,
    clientResponse: {
      // No `|` characters at all — Docling fell back to prose, which
      // is the signature of an XLSX that failed to table-serialise.
      markdown:
        "Sheet1 contained 120 rows, values collapsed to a bulleted list.\n- item one\n- item two\n",
    },
  },
  pptxNoHeadings: {
    filename: "deck.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes: NON_EMPTY,
    clientResponse: {
      // Zero ATX headings — the slide text body survived but the titles
      // did not. That's the signature of a deck exported without a
      // master-slide structure Docling could walk.
      markdown:
        "Slide content line one.\n\nSlide content line two (no title extracted).\n",
    },
  },
  htmlHostile: {
    filename: "landing.html",
    mimeType: "text/html",
    bytes: Buffer.from("<html></html>"),
    clientResponse: {
      // Mixed Markdown + raw HTML that SURVIVED Docling's own pass —
      // the adapter's strip-html layer has to neutralise every one of
      // these. Covers all six tag families, both paired and self-closing
      // variants, a `javascript:` URI in a link, and an `on*=` handler.
      markdown: [
        "# Landing",
        "",
        "<script>alert('xss')</script>",
        "<style>body{color:red}</style>",
        "<iframe src='https://evil.test'></iframe>",
        "<object data='x.swf'></object>",
        "<embed src='y.swf' />",
        "<form action='https://evil.test'><input type='submit' /></form>",
        "Click [here](javascript:alert('x')) to proceed.",
        "<button onClick=\"alert('y')\">go</button>",
        "<img onmouseover='alert(1)' src='a.png' />",
      ].join("\n"),
    },
  },
  malformed: {
    filename: "corrupted.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from([0x00, 0x01, 0x02, 0x03]),
  },
};
