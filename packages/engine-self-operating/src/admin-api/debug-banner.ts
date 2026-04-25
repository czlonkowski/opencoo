/**
 * `LLM_DEBUG_LOG=1` banner injector (PR 28 / plan #128,
 * THREAT-MODEL §3.13).
 *
 * When the engine boots with `LLM_DEBUG_LOG=1`, every JSON
 * response from the admin API carries a `_llmDebugLogActive:
 * true` field. The Management UI surfaces a persistent banner
 * so the operator can never miss the fact that LLM prompts +
 * responses are being mirrored to `llm_usage_debug` (i.e. that
 * audit retention applies and PII may be present in debug rows).
 *
 * Implementation: an onSend hook on the admin-api scope that
 * mutates JSON bodies. Non-JSON responses (set-cookie returns,
 * static file fallback) are untouched — the hook checks the
 * Content-Type before parsing.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const BANNER_FIELD = "_llmDebugLogActive";

export interface AttachDebugBannerOptions {
  readonly llmDebugLog: boolean;
}

export function attachDebugBannerHook(
  app: FastifyInstance,
  options: AttachDebugBannerOptions,
): void {
  // Short-circuit: when the env var isn't set, register no hook.
  // Boot-path overhead stays at zero in production; the hook
  // only exists when an operator opted into debug logging.
  if (!options.llmDebugLog) return;

  app.addHook(
    "onSend",
    async (
      _req: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
    ): Promise<unknown> => {
      const contentType = reply.getHeader("content-type");
      const ct = Array.isArray(contentType) ? contentType[0] : contentType;
      if (typeof ct !== "string" || !ct.includes("application/json")) {
        return payload;
      }
      // Fastify serialises objects to a string before this hook;
      // we re-parse, mutate, re-serialise. Cheap, and only fires
      // when the env var is on.
      let body: unknown;
      if (typeof payload === "string") {
        try {
          body = JSON.parse(payload);
        } catch {
          return payload;
        }
      } else if (Buffer.isBuffer(payload)) {
        try {
          body = JSON.parse(payload.toString("utf8"));
        } catch {
          return payload;
        }
      } else {
        body = payload;
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return payload;
      }
      const out = { ...(body as Record<string, unknown>), [BANNER_FIELD]: true };
      return JSON.stringify(out);
    },
  );
}

export const DEBUG_BANNER_FIELD = BANNER_FIELD;
