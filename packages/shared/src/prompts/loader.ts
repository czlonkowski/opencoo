/**
 * Prompt loader. Pure synchronous lookup against an inlined
 * registry — no filesystem I/O at runtime so the loader is safe
 * to call from any context (workers, scheduled jobs, request
 * handlers).
 *
 * Locale fallback (per Q7): `auto` → `en`, unknown → `en`. Both
 * surface as `fallbackApplied: true` so callers (engine harness,
 * audit log) can record the fallback at their preferred level
 * without the loader making logging assumptions.
 *
 * The PROMPT_NAMES / PROMPT_LOCALES tuples are the single source
 * of truth for what the loader supports — adding a new prompt
 * requires extending both the tuple AND the inlined registry, so
 * a stale entry in only one half fails type-check.
 */
import {
  CLASSIFIER_PROMPT_VERSION,
  EN_CLASSIFIER_PROMPT,
} from "./en-classifier.js";
import { PL_CLASSIFIER_PROMPT } from "./pl-classifier.js";
import {
  COMPILER_PROMPT_VERSION,
  EN_COMPILER_PROMPT,
} from "./en-compiler.js";
import { PL_COMPILER_PROMPT } from "./pl-compiler.js";
import {
  EN_HEARTBEAT_PROMPT,
  HEARTBEAT_PROMPT_VERSION,
} from "./en-heartbeat.js";
import { PL_HEARTBEAT_PROMPT } from "./pl-heartbeat.js";
import {
  EN_LINT_PROMPT,
  LINT_PROMPT_VERSION,
} from "./en-lint.js";
import { PL_LINT_PROMPT } from "./pl-lint.js";
import {
  CHAT_PROMPT_VERSION,
  EN_CHAT_PROMPT,
} from "./en-chat.js";
import { PL_CHAT_PROMPT } from "./pl-chat.js";
import {
  EN_SURFACER_PROMPT,
  SURFACER_PROMPT_VERSION,
} from "./en-surfacer.js";
import { PL_SURFACER_PROMPT } from "./pl-surfacer.js";
import {
  BUILDER_PROMPT_VERSION,
  EN_BUILDER_PROMPT,
} from "./en-builder.js";
import { PL_BUILDER_PROMPT } from "./pl-builder.js";

export const PROMPT_NAMES = [
  "classifier",
  "compiler",
  "heartbeat",
  "lint",
  "chat",
  "surfacer",
  "builder",
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const PROMPT_LOCALES = ["en", "pl", "auto"] as const;
export type PromptLocale = (typeof PROMPT_LOCALES)[number];

/**
 * Inlined registry — locale × name → prompt body. Adding a new
 * (locale, name) pair requires touching this map AND the source
 * .ts module that exports the body string. Keeping the lookup
 * pure-function lets us avoid build-time copy of .md files into
 * dist/ (which tsc doesn't do natively).
 */
const REGISTRY: {
  readonly [L in Exclude<PromptLocale, "auto">]: {
    readonly [N in PromptName]: string;
  };
} = {
  en: {
    classifier: EN_CLASSIFIER_PROMPT,
    compiler: EN_COMPILER_PROMPT,
    heartbeat: EN_HEARTBEAT_PROMPT,
    lint: EN_LINT_PROMPT,
    chat: EN_CHAT_PROMPT,
    surfacer: EN_SURFACER_PROMPT,
    builder: EN_BUILDER_PROMPT,
  },
  pl: {
    classifier: PL_CLASSIFIER_PROMPT,
    compiler: PL_COMPILER_PROMPT,
    heartbeat: PL_HEARTBEAT_PROMPT,
    lint: PL_LINT_PROMPT,
    chat: PL_CHAT_PROMPT,
    surfacer: PL_SURFACER_PROMPT,
    builder: PL_BUILDER_PROMPT,
  },
};

/**
 * Version registry — one VERSION per prompt NAME (not per locale).
 * EN and PL move in lockstep so this map is locale-free; the
 * loader exposes the value through `LoadedPrompt.version`. The
 * compiler writes it into `page_citations.prompt_version` so a
 * stale-output bug can be triaged by querying which version
 * produced which page.
 */
const VERSIONS: { readonly [N in PromptName]: string } = {
  classifier: CLASSIFIER_PROMPT_VERSION,
  compiler: COMPILER_PROMPT_VERSION,
  heartbeat: HEARTBEAT_PROMPT_VERSION,
  lint: LINT_PROMPT_VERSION,
  chat: CHAT_PROMPT_VERSION,
  surfacer: SURFACER_PROMPT_VERSION,
  builder: BUILDER_PROMPT_VERSION,
};

export interface LoadPromptArgs {
  readonly name: PromptName;
  readonly locale: PromptLocale;
}

export interface LoadedPrompt {
  readonly name: PromptName;
  /** Effective locale after fallback resolution — never `auto`,
   *  always `en` or `pl`. */
  readonly locale: Exclude<PromptLocale, "auto">;
  readonly body: string;
  /** Semver-shaped string identifying this prompt revision.
   *  Persisted by the compiler into `page_citations.prompt_version`
   *  so a stale-output bug can be triaged by querying which version
   *  produced which page. EN and PL of the same name share one
   *  version. */
  readonly version: string;
  /** True when the requested locale was `auto` or an unknown
   *  string and we fell back to `en`. The caller logs this at
   *  whatever level it deems appropriate (warn for production,
   *  debug for tests). */
  readonly fallbackApplied: boolean;
}

const KNOWN_CONCRETE_LOCALES = new Set<string>(["en", "pl"]);

export function loadPrompt(args: LoadPromptArgs): LoadedPrompt {
  const requested = args.locale;
  const fallbackApplied = requested === "auto" || !KNOWN_CONCRETE_LOCALES.has(requested);
  const effective: Exclude<PromptLocale, "auto"> = fallbackApplied
    ? "en"
    : (requested as Exclude<PromptLocale, "auto">);
  return {
    name: args.name,
    locale: effective,
    body: REGISTRY[effective][args.name],
    version: VERSIONS[args.name],
    fallbackApplied,
  };
}
