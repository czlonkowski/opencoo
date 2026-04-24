# @opencoo/converter-docling

`DocumentConverterAdapter` implementation backed by a [Docling](https://github.com/DS4SD/docling) sidecar. Converts PDF / DOCX / PPTX / XLSX / HTML bytes into sanitised Markdown suitable for the opencoo ingestion pipeline.

Implements the `DocumentConverterAdapter` contract from `@opencoo/shared/adapter-contract-tests/document-converter` — every assertion the contract requires is verified at test time.

## Slug + MIME types

- **Slug:** `converter-docling`
- **MIME types (v0.1):**
  - `application/pdf`
  - `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX)
  - `application/vnd.openxmlformats-officedocument.presentationml.presentation` (PPTX)
  - `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX)
  - `text/html`

Images and OCR are deferred to v0.2.

## Usage

```ts
import { converterDocling, DoclingHttpClient } from "@opencoo/converter-docling";

const adapter = converterDocling({
  client: new DoclingHttpClient({ url: "http://docling:5001" }),
});

const result = await adapter.convert({
  bytes: buffer,
  mimeType: "application/pdf",
  filename: "strategy.pdf",
});
// result.markdown        — scrubbed, normalised Markdown
// result.structureSignals — { detectedTables, gfmPipes, detectedHeadings }
// result.degraded         — true iff a v0.1 heuristic fired
// result.degradationReason — 'xlsx-no-pipes' | 'pptx-no-headings' (only when degraded)
```

`DOCLING_URL` is **adapter configuration**, not an engine env var. It is passed to `DoclingHttpClient` by the routing layer that wires this adapter — it is NOT in the opencoo root `.env.example` allow-list.

## What the adapter does on top of Docling (THREAT-MODEL §3.2)

1. **Transport disable-flags.** Every POST to Docling sends `disable_remote_fetch | disable_ole_embedded | disable_xslt_expansion | disable_macros`. These exact flag names track Docling's v1alpha spec; the *set* of disabled behaviours is the invariant. If a Docling version bumps the names, update the client but never loosen the intent.
2. **Hostile-HTML scrub.** Six tag families (`script | style | iframe | object | embed | form`, paired and self-closing) are regex-stripped along with their bodies. `javascript:` URIs inside Markdown links are rewritten to `](#)` — link text is preserved, href is inert. `on*=` inline event-handler attributes are stripped (double- and single-quoted forms).
3. **`@opencoo/shared/text-normalize`.** Applied exactly once on the scrubbed output. Idempotent by construction — a second pass is a no-op.
4. **StructureSignals re-derivation.** Even when Docling self-reports signals, the adapter re-counts tables / pipes / headings from the final scrubbed Markdown. We trust *our* output, not the sidecar's.
5. **Degradation heuristics (v0.1, bounded).**
   - `xlsx-no-pipes` — XLSX that converts with zero `|` outside fences. The sheet didn't survive table serialisation.
   - `pptx-no-headings` — PPTX that converts with zero ATX headings. Slide titles were lost.
   Adding a new heuristic requires a PR: a named reason constant, a matching contract-fixture case, and a THREAT-MODEL §3.2 note.
6. **Fail-closed.** Any thrown error from the client becomes `ConversionError('malformed-input')` with the original cause chained. Router-side retry policy treats this as `errorClass: 'validation'` — no hot-looping on poisoned bytes.

## Testing

Two tiers — standard for every adapter under `packages/adapters/*`:

- **Use-case tier** — `tests/converter-docling.test.ts`. Runs on every `pnpm test`. Uses `MockDoclingClient` (seeded with canned responses per fixture case) so the suite is hermetic and fast.
- **Contract tier** — `tests/converter-docling.contract.test.ts`. Gated on `DOCLING_URL`. Runs the same assertion matrix against a live sidecar.

```bash
# use-case tier (always)
pnpm --filter @opencoo/converter-docling test

# contract tier (gated — start your local Docling first)
DOCLING_URL=http://localhost:5001 pnpm --filter @opencoo/converter-docling test
```

Real fixture bytes for the contract tier live under `tests/fixtures/real/` and are **not committed** — drop them in locally before running.

## Adding a new converter adapter

Follow the same layout:

1. `packages/adapters/converter-<slug>/` with `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/`, `tests/`.
2. Implement `DocumentConverterAdapter` from `@opencoo/shared/adapter-contract-tests/document-converter`.
3. Export your MIME-type list + factory + testing mock (if needed).
4. Use-case test file imports `documentConverterContract` and your mock.
5. Contract test file `describe.runIf`-gated on whatever env var names your sidecar's URL.
6. Add the package to `pnpm-workspace.yaml` if the glob doesn't already include it (today: `packages/adapters/*`).
