/**
 * light-summary.ts (PR-F)
 *
 * Helper that calls the Light-tier LLM router to produce a
 * ≤25-word Polish one-liner summarising a single Asana event.
 * Called when `lightSummaryEnabled: true` — but note that the actual
 * wiring that calls this helper from the ingestion pipeline is deferred
 * to a follow-up PR (phase-b or PR-G). Until then `lightSummaryEnabled`
 * is a no-op config knob; see `binding-config.ts` and adapter.ts comment
 * block near `lightSummaryEnabled`. This helper is fully tested and
 * exported so the wiring PR is purely a receiver/pipeline change.
 *
 * THREAT-MODEL compliance:
 *   - §2 invariant 11: event content logged at debug only (never info).
 *   - §3.4 XML spotlighting: event content wrapped via the canonical
 *     `spotlight()` helper from @opencoo/shared/spotlight — prevents
 *     injection via `</source_content>` or `<system>` in task names.
 *   - Tier 'light', max_tokens 120 (enforced via prompt instruction;
 *     the LLM router's generateText call honours the router's budget).
 *   - On any LLM failure: logs warn, returns undefined — caller
 *     omits metadata.summary and continues.
 */
import type { DomainId } from "@opencoo/shared/db";
import type { GenerateOpts, GenerateTextResult } from "@opencoo/shared/llm-router";
import { spotlight } from "@opencoo/shared/spotlight";

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
  // Use the canonical spotlight() helper per THREAT-MODEL §3.4.
  // This escapes `</source_content>`, `<system>`, `<assistant>` and
  // other sentinels so injected tag sequences in task names cannot
  // close the envelope early or impersonate a chat-role marker.
  const envelope = spotlight({
    content: JSON.stringify(args.event),
    source: "asana-event",
    fetchedAt: new Date(),
  });

  const prompt = `${SYSTEM_PROMPT}

Zdarzenie do podsumowania:
${envelope}

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
  } catch (err) {
    // THREAT-MODEL §2 invariant 11: do not log event content at info level.
    // The warning message is metadata-only (no payload bytes).
    console.warn(
      "source-asana: light-summary LLM call failed",
      {
        pipeline: args.pipeline,
        domainId: args.domainId,
        // Include a safe error message string only — never the event payload.
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}
