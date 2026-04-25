/**
 * Chat agent output schema (PR 20 part B / plan #97 Q3).
 *
 * The LLM returns this exact shape via `router.generateObject`;
 * Zod-strict parses fail-closed as
 * `LlmProviderError(validation)` → DLQ.
 *
 * Invariants enforced:
 *   - `answer` is non-empty (an empty answer is meaningless).
 *   - `citations` is capped at 20 (Q3) — beyond that the user
 *     is asking too broad a question; narrow the answer.
 *   - Empty citations is valid for an ungrounded answer
 *     ("I don't have that information") — the prompt steers
 *     the model to return that explicitly rather than
 *     hallucinate.
 */
import { z } from "zod";

export const CHAT_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    answer: z.string().min(1),
    citations: z.array(z.string().min(1)).max(20),
  })
  .strict();

export type ChatOutput = z.infer<typeof CHAT_OUTPUT_SCHEMA>;
