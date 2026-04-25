/**
 * Prompt version manifest (PR 29 / plan #131, decision Q6).
 *
 * Const map of `(prompt-name) → semver`. The Management UI's
 * Prompts tab consumes this via the new
 * `GET /api/admin/prompts` endpoint to render the prompts
 * shipped with this build. The build version comes from each
 * prompt module's `*_PROMPT_VERSION` constant — this file
 * aggregates them into a single import.
 *
 * The `PROMPT_VERSION_MANIFEST` is a flat map; every locale
 * for a given prompt has the SAME version (the prompt body
 * differs across locales, but the version is the prompt's
 * editorial revision, not its localisation revision). The
 * Prompts tab's per-locale rendering walks
 * `PROMPT_LOCALES × PROMPT_VERSION_MANIFEST` to build the
 * `(name, locale, version)` rows.
 *
 * Adding a new prompt:
 *   1. Add the version constant export to `<lang>-<name>.ts`.
 *   2. Add the `(name, version)` entry below.
 *   3. The loader's `PROMPT_NAMES` tuple must already cover it.
 *
 * The `PROMPT_NAMES` tuple in `loader.ts` is the source of
 * truth for what names exist; this manifest aliases each name
 * to its current shipped version.
 */
import { CLASSIFIER_PROMPT_VERSION } from "./en-classifier.js";
import { COMPILER_PROMPT_VERSION } from "./en-compiler.js";
import { HEARTBEAT_PROMPT_VERSION } from "./en-heartbeat.js";
import { LINT_PROMPT_VERSION } from "./en-lint.js";
import { CHAT_PROMPT_VERSION } from "./en-chat.js";
import { SURFACER_PROMPT_VERSION } from "./en-surfacer.js";
import { BUILDER_PROMPT_VERSION } from "./en-builder.js";
import { WORLDVIEW_DOMAIN_PROMPT_VERSION } from "./en-worldview-domain.js";
import { WORLDVIEW_COMPANY_PROMPT_VERSION } from "./en-worldview-company.js";
import { PROMPT_NAMES, type PromptName } from "./loader.js";

export const PROMPT_VERSION_MANIFEST: Readonly<Record<PromptName, string>> = {
  classifier: CLASSIFIER_PROMPT_VERSION,
  compiler: COMPILER_PROMPT_VERSION,
  heartbeat: HEARTBEAT_PROMPT_VERSION,
  lint: LINT_PROMPT_VERSION,
  chat: CHAT_PROMPT_VERSION,
  surfacer: SURFACER_PROMPT_VERSION,
  builder: BUILDER_PROMPT_VERSION,
  "worldview-domain": WORLDVIEW_DOMAIN_PROMPT_VERSION,
  "worldview-company": WORLDVIEW_COMPANY_PROMPT_VERSION,
};

/** Type-level guard: every PromptName must have a version
 *  entry. If a future PR adds a new prompt to PROMPT_NAMES
 *  without updating the manifest, this array fails to type-
 *  check (the manifest's index signature widens to
 *  `PromptName` which constrains the keys). */
export const PROMPT_NAMES_FROM_MANIFEST: ReadonlyArray<PromptName> = [
  ...PROMPT_NAMES,
];
