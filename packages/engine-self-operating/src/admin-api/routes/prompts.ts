/**
 * Review Dashboard — prompts manifest (PR 29 / plan #131,
 * decision Q5).
 *
 * Returns one entry per `PromptName` with the (locale,
 * version) pairs shipped with this build. Source of truth:
 * `@opencoo/shared/prompts`'s `PROMPT_VERSION_MANIFEST` const
 * map (PR 29 addition) + `PROMPT_LOCALES`.
 */
import type { FastifyInstance } from "fastify";

import {
  PROMPT_LOCALES,
  PROMPT_NAMES,
  PROMPT_VERSION_MANIFEST,
} from "@opencoo/shared/prompts";

export interface RegisterPromptsRoutesArgs {
  readonly app: FastifyInstance;
}

export function registerPromptsRoutes(args: RegisterPromptsRoutesArgs): void {
  args.app.get("/api/admin/prompts", async () => {
    const entries = PROMPT_NAMES.map((name) => ({
      name,
      locales: PROMPT_LOCALES
        // The 'auto' locale resolves at call time — it's not a
        // distinct prompt body, so we don't surface it here.
        .filter((l) => l !== "auto")
        .map((locale) => ({
          locale,
          version: PROMPT_VERSION_MANIFEST[name],
        })),
    }));
    return { entries };
  });
}
