/**
 * `contradictions` detector — the only LLM-backed Lint detector.
 * Samples up to N page pairs from the input, asks the LLM
 * (lint prompt, thinker tier) which pairs carry factually
 * contradictory claims, and surfaces each as a finding.
 *
 * Per Q7 (architecture): cap at 50 page-pair samples per run
 * so cost stays bounded. The orchestrator decides which pairs
 * to sample (v0.1: deterministic — first N pairs of the
 * sorted page list); the detector trusts the cap.
 *
 * The LLM call is a single prompt that includes ALL the
 * sampled page bodies (each spotlighted in its own
 * <source_content>). The Zod-validated output is an array of
 * contradiction records that this detector translates into
 * `LintFinding[]`.
 */
import { z } from "zod";

import { spotlight } from "@opencoo/shared/spotlight";
import { loadPrompt } from "@opencoo/shared/prompts";
import type { LlmRouter } from "@opencoo/shared/llm-router";
import type { DomainId } from "@opencoo/shared/db";

import type { LintFinding } from "../types.js";

/**
 * Architectural cap. The orchestrator should stop pairing
 * before this — but if it doesn't, we slice here so a buggy
 * caller can't blow the per-run budget.
 */
export const CONTRADICTIONS_PAIR_CAP = 50;

const CONTRADICTION_RECORD = z
  .object({
    page_a: z.string().min(1),
    page_b: z.string().min(1),
    claim_a: z.string().min(1),
    claim_b: z.string().min(1),
    severity: z.enum(["low", "medium", "high"]),
    rationale: z.string().min(1),
  })
  .strict();

export const CONTRADICTIONS_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    contradictions: z.array(CONTRADICTION_RECORD),
  })
  .strict();

export interface PageBody {
  readonly domainSlug: string;
  readonly path: string;
  readonly body: string;
}

export interface ContradictionsArgs {
  readonly router: LlmRouter;
  readonly domainId: DomainId;
  readonly locale: "en" | "pl" | "auto";
  /** The page bodies the orchestrator picked for this run.
   *  Already capped by the orchestrator; the detector enforces
   *  the cap defensively. */
  readonly pages: readonly PageBody[];
  readonly fetchedAt: Date;
}

export async function detectContradictions(
  args: ContradictionsArgs,
): Promise<readonly LintFinding[]> {
  const sampled = args.pages.slice(0, CONTRADICTIONS_PAIR_CAP);
  if (sampled.length < 2) return [];

  const prompt = loadPrompt({ name: "lint", locale: args.locale });
  const envelopes = sampled
    .map((p) =>
      spotlight({
        content: `<<page-path>>${p.domainSlug}/${p.path}<<end>>\n${p.body}`,
        source: `wiki://${p.domainSlug}/${p.path}`,
        fetchedAt: args.fetchedAt,
      }),
    )
    .join("\n\n");

  const fullPrompt = `${prompt.body}\n\n# Pages to analyse\n${envelopes}`;

  const result = await args.router.generateObject({
    domainId: args.domainId,
    tier: "thinker",
    pipelineOrAgent: "lint:contradictions",
    prompt: fullPrompt,
    schema: CONTRADICTIONS_OUTPUT_SCHEMA,
  });

  const findings: LintFinding[] = [];
  for (const c of result.object.contradictions) {
    findings.push({
      kind: "contradictions",
      severity: c.severity,
      scope: `${c.page_a}↔${c.page_b}`,
      message: `${c.page_a} and ${c.page_b} carry contradictory claims: "${c.claim_a}" vs "${c.claim_b}"`,
      detail: {
        pageA: c.page_a,
        pageB: c.page_b,
        claimA: c.claim_a,
        claimB: c.claim_b,
        rationale: c.rationale,
      },
    });
  }
  return findings;
}
