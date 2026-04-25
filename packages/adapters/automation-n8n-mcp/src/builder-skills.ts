/**
 * Vendored `n8n-skills` loader (PR 25 / plan #120).
 *
 * v0.1 ships a STATIC `builderSkills` const populated from the
 * filesystem snapshot under `vendor/n8n-skills/`. The pin is
 * recorded in `vendor/n8n-skills.lock.json` (tag + sha +
 * fetchedAt). PR 38 promotes this to a function-with-filter
 * shape; PR 41 layers the partner overlay on top.
 *
 * Resolution: the JS module ships in `dist/`, the source in
 * `src/` — both have the same relative path to `vendor/`
 * (one parent level), so `import.meta.url` works for both.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Zod schema for a vendored BuilderSkill JSON file. `.strict()`
 * rejects unknown keys at boundary so a malformed snapshot fails
 * loud at module load (instead of silently dropping fields).
 */
const builderSkillSchema = z
  .object({
    slug: z.string().min(1),
    version: z.string().min(1),
    sha: z.string().min(1),
    body: z.string().min(1),
    summary: z.string().min(1).optional(),
  })
  .strict();

export type BuilderSkill = z.infer<typeof builderSkillSchema>;

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(HERE, "..", "vendor", "n8n-skills");

function loadVendoredSkills(): readonly BuilderSkill[] {
  const out: BuilderSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(VENDOR_DIR);
  } catch (err) {
    // Fail loud — the adapter ships with a vendored catalog and
    // a missing/unreadable directory means a packaging or deploy
    // bug (e.g. `vendor/**` not in the published `files` list).
    // Silently returning [] would mask this and let Builder run
    // with no skills, producing empty deployment proposals.
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new Error(
      `automation-n8n-mcp: failed to read vendored BuilderSkill catalog at ${VENDOR_DIR}${detail}. ` +
        `Expected vendor/n8n-skills/ to be present at runtime; this usually indicates a packaging/deploy issue.`,
    );
  }
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) continue;
    const raw = readFileSync(join(VENDOR_DIR, name), "utf8");
    const parseResult = builderSkillSchema.safeParse(JSON.parse(raw));
    if (!parseResult.success) {
      throw new Error(
        `vendor/n8n-skills/${name}: malformed BuilderSkill — ${parseResult.error.message}`,
      );
    }
    out.push(parseResult.data);
  }
  return out;
}

/** Static catalog — read once at module load. */
export const builderSkills: readonly BuilderSkill[] = loadVendoredSkills();
