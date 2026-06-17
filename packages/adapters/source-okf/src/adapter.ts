/**
 * OKF SourceAdapter (PR-OKF3b).
 *
 * Polling adapter that walks a local Open Knowledge Format (OKF) v0.1
 * bundle directory and emits each concept document as a
 * `content_kind: 'okf-bundle'` document:
 *
 *   1. Walks the bundle (or `subdir` within it) recursively, collecting
 *      `.md` files. Reserved files (`index.md` / `log.md` at ANY depth,
 *      OKF §3.1) are skipped — they carry structure, not concepts.
 *   2. Concept id = the bundle-relative path minus `.md`, in POSIX form
 *      (`tables/blocks.md` → `tables/blocks`). The id is emitted as both
 *      `sourceDocId` (stable across revisions) and `sourceRef` — the
 *      OKF compiler uses `sourceRef` directly as the wiki page path
 *      (no prefix).
 *   3. `sourceRevision` = sha256(file bytes).slice(0, 16). A content
 *      change yields a new revision; an unchanged file is skipped.
 *   4. The cursor is a JSON revision-map `{ conceptId: revision }`. A
 *      null/malformed cursor re-emits every concept (full scan); a
 *      cursor whose revision matches the current file is a no-op.
 *   5. Enforces the 1 MiB ceiling per the SourceAdapter contract
 *      (assertion 7) — oversize concepts are dropped.
 *
 * The compiler-side dispatch lives in
 * `engine-ingestion/src/pipelines/compilation-worker.ts`: when the
 * binding's `contentKind` is `'okf-bundle'`, the worker routes to the
 * deterministic `compileOkfConcept` passthrough (no LLM). The adapter
 * does NOT set `contentKind` on the emitted document — the engine reads
 * it from the binding row.
 *
 * CREDENTIALS: a local OKF bundle has no secret. The factory takes
 * `(credentialStore, credentialId)` to match the shared
 * `AdapterFactoryArgs` shape, but the adapter never reads them
 * (THREAT-MODEL §3.6 invariant 11 is satisfied vacuously — no inline
 * credentials, nothing to resolve). The credential arg is reserved for
 * a future git-clone transport (architecture §17 Open).
 *
 * CONTAINMENT (THREAT-MODEL §3.4): reads stay inside the bundle root.
 * Two guards: (1) SYMLINKS are not followed — a Dirent symlink reports
 * neither `isFile` nor `isDirectory`, so the walk can't escape via a
 * link; (2) `subdir` is rejected at config-parse AND re-checked at
 * runtime (resolve-containment) so it can't escape the bundle via
 * `..`. A derived concept id can therefore never contain `..`.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";
import { isReserved } from "@opencoo/shared/page-spec";
import type {
  SourceAdapter,
  SourceChangedDocument,
  SourceScanArgs,
  SourceScanResult,
} from "@opencoo/shared/source-adapter";

import { okfBindingConfigSchema } from "./binding-config.js";

/** SourceAdapter contract assertion 7 — content ceiling. */
const ONE_MIB = 1024 * 1024;

/** Stable adapter slug — matches `sources_bindings.adapter_slug`. */
export const OKF_ADAPTER_SLUG = "okf" as const;

export interface CreateOkfSourceAdapterArgs {
  /** Reserved for a future git-clone transport — unused in v0.1. */
  readonly credentialStore: CredentialStore;
  /** Reserved for a future git-clone transport — unused in v0.1. */
  readonly credentialId: CredentialId;
  /** Persisted `sources_bindings.config` blob — parsed inside. */
  readonly config: unknown;
  /** Optional clock injection for deterministic tests. */
  readonly now?: () => Date;
}

interface Concept {
  readonly conceptId: string;
  readonly absPath: string;
}

export function createOkfSourceAdapter(
  args: CreateOkfSourceAdapterArgs,
): SourceAdapter {
  const config = okfBindingConfigSchema.parse(args.config);
  const now = args.now ?? ((): Date => new Date());
  const scanRoot =
    config.subdir !== undefined && config.subdir.length > 0
      ? join(config.bundlePath, config.subdir)
      : config.bundlePath;

  // Defense-in-depth (THREAT-MODEL §3.4): the schema refine already
  // rejects `..`/absolute `subdir`, but a fail-closed RUNTIME guard —
  // independent of where the config came from (a direct DB poke, a
  // config importer) — is what actually prevents a `subdir` from
  // escaping the bundle root and exfiltrating arbitrary local files.
  // We throw at construction, before scan() ever walks the tree.
  const resolvedBundle = resolve(config.bundlePath);
  const resolvedRoot = resolve(scanRoot);
  if (
    resolvedRoot !== resolvedBundle &&
    !resolvedRoot.startsWith(resolvedBundle + sep)
  ) {
    throw new Error(
      `okf: subdir '${config.subdir ?? ""}' resolves outside bundlePath`,
    );
  }

  return {
    slug: OKF_ADAPTER_SLUG,
    async scan(scanArgs: SourceScanArgs): Promise<SourceScanResult> {
      const fetchedAt = now();
      const prev = parseCursor(scanArgs.cursor);
      const concepts = await walkConcepts(scanRoot);

      const documents: SourceChangedDocument[] = [];
      // null-prototype dictionary — keys are filesystem-derived concept
      // ids; a concept named `__proto__`/`constructor` must be an inert
      // data key, not a prototype mutation.
      const nextCursorMap: Record<string, string> = Object.create(null);
      for (const { conceptId, absPath } of concepts) {
        const contentBytes = await readFile(absPath);
        // 1 MiB ceiling — drop oversize concepts entirely (and omit them
        // from the cursor, so a later shrink re-surfaces them as new).
        if (contentBytes.length > ONE_MIB) continue;
        const sourceRevision = sha256Prefix(contentBytes);
        nextCursorMap[conceptId] = sourceRevision;
        // Unchanged since the last scan → no-op.
        if (prev[conceptId] === sourceRevision) continue;
        documents.push({
          sourceDocId: conceptId,
          sourceRevision,
          sourceRef: conceptId,
          fetchedAt,
          contentBytes,
        });
      }

      return { documents, nextCursor: JSON.stringify(nextCursorMap) };
    },
  };
}

function sha256Prefix(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Parse the persisted revision-map cursor. A null or malformed cursor
 * yields an empty map → every concept re-surfaces (full re-scan). Only
 * string-valued entries are kept (defensive against a hand-edited
 * cursor).
 */
function parseCursor(cursor: string | null): Record<string, string> {
  const empty = (): Record<string, string> =>
    Object.create(null) as Record<string, string>;
  if (cursor === null || cursor.length === 0) return empty();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return empty();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return empty();
  }
  // null-prototype dictionary — the cursor is untrusted persisted JSON;
  // a `__proto__`/`constructor` key must be an inert data key.
  const out: Record<string, string> = empty();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Recursively collect concept docs under `root`. Reserved files
 * (`index.md` / `log.md` at any depth, OKF §3.1) are skipped; symlinks
 * are not followed (a Dirent symlink reports neither isFile nor
 * isDirectory). Entries are sorted for deterministic emission order.
 */
async function walkConcepts(root: string): Promise<Concept[]> {
  const out: Concept[] = [];
  async function recurse(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(abs);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        if (isReserved(entry.name)) continue;
        const rel = relative(root, abs).split(sep).join("/");
        if (rel.length === 0 || rel.startsWith("..")) continue;
        const conceptId = rel.replace(/\.md$/i, "");
        out.push({ conceptId, absPath: abs });
      }
    }
  }
  await recurse(root);
  return out;
}
