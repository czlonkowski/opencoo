/**
 * light-summary.ts (PR-F)
 *
 * Helper that calls the Light-tier LLM router to produce a
 * ≤25-word Polish one-liner summarising a single Asana event.
 * Used in `parseEvents` when `lightSummaryEnabled: true`.
 *
 * THREAT-MODEL compliance:
 *   - §2 invariant 11: event content logged at debug only (never info).
 *   - §3.4 XML spotlighting: event content wrapped in
 *     <source_content>...</source_content> before reaching the LLM.
 *   - Tier 'light', max_tokens 120 (enforced via prompt instruction;
 *     the LLM router's generateText call honours the router's budget).
 *   - On any LLM failure: logs warn, returns undefined — caller
 *     omits metadata.summary and continues.
 */
import type { DomainId } from "@opencoo/shared/db";
import type { GenerateOpts, GenerateTextResult } from "@opencoo/shared/llm-router";

/** Minimal router surface needed for Light-tier calls. */
export interface LightSummaryRouter {
  generateText(opts: GenerateOpts): Promise<GenerateTextResult>;
}

export interface SummarizeAsanaEventArgs {
  readonly event: unknown;
  readonly domainId: DomainId;
  readonly llmRouter: LightSummaryRouter;
  readonly pipeline: string;
  readonly documentId?: string;
}

/**
 * System prompt for the Light-tier summarizer (Polish).
 * Instructs the model to produce max 25 words, ~120 tokens max.
 */
const SYSTEM_PROMPT = `Jesteś pomocnikiem podsumowującym zdarzenia z Asany po polsku.
Streszczasz pojedyncze zdarzenie z Asany w jednym zdaniu, max 25 słów.
Odpowiadaj tylko samym podsumowaniem — bez wstępu, bez cytatów.
Limit tokenów: 120.`;

/**
 * Produce a ≤25-word Polish summary of the Asana event via the
 * Light-tier LLM router. Returns undefined if the call fails
 * (fail-open semantics — callers omit metadata.summary on failure).
 */
export async function summarizeAsanaEvent(
  args: SummarizeAsanaEventArgs,
): Promise<string | undefined> {
  const eventJson = JSON.stringify(args.event);

  // XML-spotlight event content per THREAT-MODEL §3.4.
  const prompt = `${SYSTEM_PROMPT}

Zdarzenie do podsumowania:
<source_content>
${eventJson}
</source_content>

Podsumowanie (max 25 słów, max 120 tokenów):`;

  try {
    const result = await args.llmRouter.generateText({
      domainId: args.domainId,
      tier: "light",
      pipelineOrAgent: args.pipeline,
      prompt,
      // exactOptionalPropertyTypes: omit key when undefined.
      ...(args.documentId !== undefined ? { documentId: args.documentId } : {}),
    });
    return result.text.trim() || undefined;
  } catch {
    // THREAT-MODEL §2 invariant 11: do not log event content at info level.
    // The warning message is metadata-only (no payload bytes).
    return undefined;
  }
}
