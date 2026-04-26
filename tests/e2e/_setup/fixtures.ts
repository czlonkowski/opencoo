/**
 * Document fixtures for the ingest-to-wiki e2e (PR 32 / plan
 * #149).
 *
 * Three flavours per planner Q5:
 *
 *   1. canonical — a normal Q4-plan-shaped doc the classifier
 *      should accept; downstream Compiler MUST land a wiki page.
 *   2. cross-domain-write attacker — loaded from PR 31's
 *      `attackerOutput` field on the classifier
 *      cross-domain-write fixture; the test wires the
 *      MockLlmClient to return this output verbatim, then
 *      asserts the classifier rejects it via
 *      ClassifierValidationError so NO write reaches Gitea.
 *   3. path-traversal attacker — same shape, loaded from the
 *      classifier path-traversal fixture; classifier must
 *      reject via ClassifierPathError.
 *
 * The PR 31 fixtures already enforce
 * `injectionDirective ⊆ injectedContent` and round-trip through
 * a Zod schema; loading them here means the e2e gate stays in
 * lockstep with the corpus. If a future fixture-regen changes
 * the attacker payload shape, the e2e fails loudly with the
 * actionable PR 31 message.
 */
import { loadFixture } from "../../../packages/shared/src/prompts/__fixtures__/injection/_loader.js";
import type { InjectionFixture } from "../../../packages/shared/src/prompts/__fixtures__/injection/_schema.js";

/** Canonical Q4 plan body — accepted by the classifier MockLlmClient
 *  with a single `wiki-execs:strategy/q4-plan.md` target. The
 *  Compiler then merges this into the page body. */
export const CANONICAL_DOC_BODY = `Q4 strategy plan — finalised after the executive offsite.

Headline priorities:
  1. Ship opencoo phase-a end-to-end.
  2. Pilot the design-partner cutover from n8n to opencoo.
  3. Continue marketplace scaffolding work for phase-b.

Owners and dates are tracked in Asana; this page is the canonical narrative.
`;

/** Canonical classifier output the MockLlmClient returns for the
 *  canonical doc — single page in the binding's allowed_paths. */
export const CANONICAL_CLASSIFIER_OUTPUT = {
  version: "v1",
  language: "en",
  summary: "Q4 strategy plan — phase-a, design-partner cutover, marketplace scaffolding",
  target_domains: [
    {
      domain_slug: "wiki-execs",
      page_paths: ["strategy/q4-plan.md"],
    },
  ],
  pipelines: ["compile.single-source"],
} as const;

/** Canonical compiler output the MockLlmClient returns for the
 *  Compiler call — a freshly-merged body that we assert lands in
 *  Gitea verbatim. */
export const CANONICAL_COMPILER_OUTPUT = {
  merged_body: `# Q4 strategy plan

Finalised after the executive offsite.

## Headline priorities

1. Ship opencoo phase-a end-to-end.
2. Pilot the design-partner cutover from n8n to opencoo.
3. Continue marketplace scaffolding work for phase-b.

Owners and dates are tracked in Asana; this page is the canonical narrative.
`,
  worldview_impact: [
    "Phase-a ship-gate is the Q4 priority",
    "Design-partner cutover is on the Q4 critical path",
  ],
} as const;

export interface AttackerFixture {
  /** Source fixture this attacker payload was loaded from. */
  readonly source: string;
  /** The body the SourceAdapter will deliver — exactly the
   *  injectedContent from the corpus, so a regression in the
   *  fixture content carries through. */
  readonly body: string;
  /** The JSON the MockLlmClient returns to the classifier — the
   *  fully-pwned classifier-output shape from the corpus's
   *  `attackerOutput.body`. */
  readonly attackerClassifierOutput: unknown;
}

/** Load the cross-domain-write attacker payload (en classifier
 *  fixture). */
export async function loadCrossDomainWriteFixture(): Promise<AttackerFixture> {
  return toAttackerFixture(
    await loadFixture("en", "classifier", "cross-domain-write"),
  );
}

/** Load the path-traversal attacker payload (en classifier
 *  fixture). */
export async function loadPathTraversalFixture(): Promise<AttackerFixture> {
  return toAttackerFixture(
    await loadFixture("en", "classifier", "path-traversal"),
  );
}

function toAttackerFixture(fixture: InjectionFixture): AttackerFixture {
  if (fixture.attackerOutput === undefined) {
    throw new Error(
      `injection fixture ${fixture.fixture} has no attackerOutput; e2e tests require one`,
    );
  }
  if (fixture.attackerOutput.kind !== "json") {
    throw new Error(
      `injection fixture ${fixture.fixture} attackerOutput is not JSON-kind; e2e wires the classifier MockLlmClient with a JSON response`,
    );
  }
  return {
    source: fixture.fixture,
    body: fixture.injectedContent,
    attackerClassifierOutput: fixture.attackerOutput.body,
  };
}
