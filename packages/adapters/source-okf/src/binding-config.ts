/**
 * Binding-config schema for the OKF SourceAdapter (PR-OKF3b).
 *
 * The adapter walks a local OKF v0.1 bundle directory and emits each
 * concept doc (markdown + YAML frontmatter) as a
 * `content_kind: 'okf-bundle'` document. The Compilation Worker routes
 * `'okf-bundle'` content to the deterministic `compileOkfConcept`
 * passthrough — no LLM, no classifier (architecture §6.3.1, §16.3).
 *
 * Fields:
 *   - `bundlePath` — local filesystem path to the OKF bundle root. The
 *     v0.1 transport is local-path only; a git-clone transport is
 *     deferred (architecture §17 Open).
 *   - `subdir` — optional sub-directory within the bundle to scan;
 *     concept ids are made relative to it when set.
 *   - `contentKind` — locked to `'okf-bundle'` for v0.1. The shared
 *     `CONTENT_KINDS` enum in `@opencoo/shared/db` is the source of
 *     truth; we accept any enum value for forward-compat (mirrors
 *     source-n8n).
 *
 * The schema carries NO credential fields — a local OKF bundle has no
 * secret to resolve (THREAT-MODEL §3.6 invariant 11 is satisfied
 * vacuously). The factory still takes `(credentialStore, credentialId)`
 * to match the shared `AdapterFactoryArgs` shape; the adapter never
 * reads them.
 */
import { z } from "zod";

import { CONTENT_KINDS, type ContentKind } from "@opencoo/shared/db";

/** Default content kind for OKF bindings — the catalog passthrough path. */
export const OKF_DEFAULT_CONTENT_KIND: ContentKind = "okf-bundle";

export const okfBindingConfigSchema = z
  .object({
    /** Local filesystem path to the OKF bundle root directory. */
    bundlePath: z.string().min(1),
    /** Optional sub-directory within the bundle to scan. Concept ids
     *  are made relative to this when set. Must stay INSIDE the bundle:
     *  no `..` segments, not absolute — otherwise `join(bundlePath,
     *  subdir)` could escape the bundle root and read arbitrary local
     *  files (THREAT-MODEL §3.4). The adapter factory also enforces
     *  containment at runtime (defense-in-depth). */
    subdir: z
      .string()
      .optional()
      .refine(
        (s) =>
          s === undefined ||
          (!s.split(/[/\\]/).includes("..") && !s.startsWith("/")),
        { message: "subdir must not contain '..' segments or be absolute" },
      ),
    /** Locked to `'okf-bundle'` for v0.1; accepts any CONTENT_KINDS
     *  value for forward-compat (mirrors source-n8n). */
    contentKind: z.enum(CONTENT_KINDS).default(OKF_DEFAULT_CONTENT_KIND),
  })
  .strict();

export type OkfBindingConfig = z.infer<typeof okfBindingConfigSchema>;
