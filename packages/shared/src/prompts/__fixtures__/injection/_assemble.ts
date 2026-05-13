// Prompt-assembly helper for the injection corpus.
//
// Mirrors the production assembly: `loadPrompt(...).body` joined
// with any prompt-specific runtime context block(s) and a single
// spotlighted envelope around the untrusted source content. THIS
// IS THE ONE PLACE the corpus replicates the production prompt
// shape — if production prompts ever start embedding additional
// envelopes (e.g. compiler with both `<existing_page>` and
// `<source_content>`), extend this helper rather than letting the
// runner know about per-prompt shapes.
//
// Today every v0.1 prompt body documents exactly one
// `<source_content>` envelope as the untrusted-input boundary
// (per architecture §6.6 layer 1 + THREAT-MODEL §3.4). The
// `<existing_page>` and `<worldview>` envelopes are TRUSTED
// channels in production but the corpus models them as part of
// `injectedContent` when needed — keeping the assembler shape
// universal across prompts.
//
// PR-Y9: the production classifier injects a "Binding constraints
// (this run only)" block between the prompt body and the envelope,
// listing the binding's `allowed_domains` and `allowed_paths`. The
// corpus mirrors that shape with a fixed, deterministic test-bind
// (`wiki-test` + `**/*.md`) so the corpus tests run against the
// same structure the production LLM sees — without this, an
// attacker-crafted directive that targets the constraints-block
// surface would not be exercised by the corpus.

import { spotlight } from "../../../spotlight/index.js";
import { loadPrompt } from "../../loader.js";
import type { InjectionFixture } from "./_schema.js";

export interface AssembledPrompt {
  /** The full prompt string the LLM would see — body + newline +
   *  prompt-specific context block(s) + spotlighted envelope. */
  readonly assembled: string;
  /** The body half (just the prompt body), kept separate so
   *  invariants can be stated against either half independently. */
  readonly body: string;
  /** The spotlighted envelope half — exactly one
   *  `<source_content>` block per the production contract. */
  readonly envelope: string;
  /** Effective version of the loaded prompt — compared to
   *  `fixture.promptVersion` to detect drift. */
  readonly effectiveVersion: string;
}

/** Deterministic test-shape binding used to render the classifier
 *  constraints block in the corpus. Kept under module scope so the
 *  fixtures' assembled prompts are byte-stable across runs. */
const CORPUS_CLASSIFIER_BINDING = {
  allowedDomains: ["wiki-test"] as const,
  allowedPaths: ["**/*.md"] as const,
};

/** Mirror of the production constraints block constructed in
 *  `packages/engine-ingestion/src/classifier/classifier.ts`. Keep
 *  the two formats byte-identical — if production drifts, the
 *  corpus must drift in lockstep or the injection tests stop
 *  modelling the real prompt shape. */
function classifierConstraintsBlock(
  allowedDomains: readonly string[],
  allowedPaths: readonly string[],
): string {
  return [
    "# Binding constraints (this run only)",
    "",
    "These are the ONLY values you may emit:",
    "",
    `- allowed_domains (you MUST pick one of these for every \`target_domains[].domain_slug\`):`,
    ...allowedDomains.map((d) => `    - ${JSON.stringify(d)}`),
    "",
    `- allowed_paths (every \`target_domains[].page_paths[*]\` must match one of these globs):`,
    ...allowedPaths.map((p) => `    - ${JSON.stringify(p)}`),
    "",
    "Any other value is rejected and the run is DLQ'd. If the document spans multiple of these allowed paths, list them in `page_paths`; do NOT invent new ones.",
  ].join("\n");
}

export function assembleForFixture(fixture: InjectionFixture): AssembledPrompt {
  const loaded = loadPrompt({ name: fixture.prompt, locale: fixture.locale });
  const envelope = spotlight({
    content: fixture.injectedContent,
    source: fixture.spotlightSource,
    fetchedAt: new Date(fixture.spotlightFetchedAt),
  });
  // Per-prompt context blocks. Only the classifier has one today
  // (PR-Y9). Adding a new entry here is the right place when a
  // future prompt grows its own per-run runtime context.
  let contextBlock = "";
  if (fixture.prompt === "classifier") {
    contextBlock = `${classifierConstraintsBlock(
      CORPUS_CLASSIFIER_BINDING.allowedDomains,
      CORPUS_CLASSIFIER_BINDING.allowedPaths,
    )}\n\n`;
  }
  return {
    assembled: `${loaded.body}\n\n${contextBlock}${envelope}`,
    body: loaded.body,
    envelope,
    effectiveVersion: loaded.version,
  };
}
