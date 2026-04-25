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
import { EN_CLASSIFIER_PROMPT } from "./en-classifier.js";
import { PL_CLASSIFIER_PROMPT } from "./pl-classifier.js";

export const PROMPT_NAMES = ["classifier"] as const;
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
  },
  pl: {
    classifier: PL_CLASSIFIER_PROMPT,
  },
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
    fallbackApplied,
  };
}
