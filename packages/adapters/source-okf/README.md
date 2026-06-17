# @opencoo/source-okf

A `SourceAdapter` that reads a local **Open Knowledge Format (OKF) v0.1**
bundle — a directory of markdown files with YAML frontmatter — and emits each
concept document for opencoo to ingest. It is the *consume* side of opencoo's
OKF conformance (the *produce* side is built into every wiki write, see
`@opencoo/shared/page-spec`).

Spec: <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>

## What it does

`scan()` walks the bundle directory and emits one `SourceChangedDocument` per
concept:

- **Reserved files are skipped.** `index.md` and `log.md` carry structure, not
  concepts, at *any* depth (OKF §3.1) — they are never emitted.
- **Concept id = bundle-relative path minus `.md`**, in POSIX form
  (`tables/blocks.md` → `tables/blocks`). It is emitted as both `sourceDocId`
  (stable across revisions) and `sourceRef`. The OKF compiler uses `sourceRef`
  directly as the wiki page path — **no prefix**, so the bundle layout is
  mirrored verbatim.
- **`contentBytes` are the file's bytes, byte-for-byte.** The downstream
  `okf-bundle` compile path (`compileOkfConcept`) maps the OKF frontmatter to
  opencoo provenance frontmatter and commits the markdown body unchanged — no
  LLM. After the standard redaction-guard pass (applied to *all* ingested
  content), a secret-free bundle round-trips byte-for-byte.
- **`sourceRevision` = `sha256(bytes).slice(0, 16)`.** The cursor is a JSON
  revision-map `{ conceptId: revision }`; a content change re-surfaces a
  concept, an unchanged file is a no-op, a removed file simply stops appearing.
- **1 MiB ceiling** per the `SourceAdapter` contract — oversize concepts are
  dropped.

## Configuration

```jsonc
{
  "bundlePath": "/srv/okf/my-bundle", // required — local bundle root
  "subdir": "datasets",               // optional — scope the walk; ids become relative to it
  "contentKind": "okf-bundle"         // default — routes to the deterministic passthrough
}
```

> **Persist `contentKind`.** The deterministic passthrough is selected by the
> binding's persisted `contentKind: "okf-bundle"`. The UI "+ New binding" wizard
> fills this default automatically. If you create an okf binding via the raw
> admin API or a bootstrap script, set `contentKind` explicitly — otherwise the
> binding falls back to the LLM `document` path and your OKF markdown is
> rewritten by the compiler instead of mirrored verbatim.

> **Concept paths must be opencoo-wiki-legal.** opencoo wiki paths are
> lowercase-ASCII (`[a-z0-9][a-z0-9/_-]*`). A concept whose mirrored path has
> uppercase, spaces, or non-ASCII characters is **skipped** with a
> `compiler.catalog_okf.skipped_nonconformant_path` warning (the rest of the
> bundle still ingests). It can't be slugified without breaking OKF's lossless
> round-trip and the intra-bundle links in the verbatim body. Google's OKF
> tooling emits lowercase paths; hand-authored bundles should too.

There is **no credential**: a local OKF bundle has no secret. The factory still
takes `(credentialStore, credentialId)` to match the shared adapter factory
shape, but never resolves them (THREAT-MODEL §3.6 invariant 11 is satisfied
vacuously — the binding config carries no inline credentials). The credential
argument is reserved for a future git-clone transport (architecture.md §17
Open); v0.1 is local-path only.

> `allowed_paths` is **advisory** for `okf-bundle` bindings: the compile path
> mirrors each concept to its bundle path verbatim and does not gate on
> `allowed_paths` (only the LLM `document` path does). The default
> (`okf/**`) exists to pass the create-time wildcard guard; replace it per
> bundle layout.

## Tests

```sh
pnpm --filter @opencoo/source-okf test           # full suite
pnpm --filter @opencoo/source-okf test:contract  # shared SourceAdapter contract only
```

The suite runs the shared `sourceAdapterContract` (polling) against a
temp-directory bundle, plus adapter-specific behaviour and a real-data pass
over Google's vendored OKF reference bundles (`crypto_bitcoin`, `ga4`).
