/**
 * Worldview pipeline output schema (PR 22 / plan #106).
 *
 * The LLM (per-domain or company aggregator) returns this exact
 * shape via `router.generateObject`. Zod-strict + a 24,000-byte
 * UTF-8 cap on `body` mean a verbose payload fails parse and the
 * pipeline retries once with a "compress further" suffix; if
 * the retry still overflows, `WorldviewOverflowError(validation)`
 * fires and the run DLQs. The cap is load-bearing — `worldview.md`
 * is injected into every downstream agent's system prompt; an
 * over-cap body pushes prompts out of the model's context
 * window.
 */
import { z } from "zod";

export const WORLDVIEW_BODY_MAX_BYTES = 24_000;

/**
 * UTF-8 byte length — JavaScript `string.length` counts code
 * units, not bytes; a kanji character is 1 code unit but 3 UTF-8
 * bytes. The model emits Markdown that may include any Unicode,
 * so we measure bytes to match what reaches the prompt.
 */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export const WORLDVIEW_OUTPUT_SCHEMA = z
  .object({
    version: z.literal("v1"),
    body: z
      .string()
      .min(1)
      .refine(
        (s) => utf8ByteLength(s) <= WORLDVIEW_BODY_MAX_BYTES,
        {
          message: `worldview body exceeds the ${WORLDVIEW_BODY_MAX_BYTES}-byte UTF-8 cap`,
        },
      ),
  })
  .strict();

export type WorldviewOutput = z.infer<typeof WORLDVIEW_OUTPUT_SCHEMA>;

export { utf8ByteLength };
