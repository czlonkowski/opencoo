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

export interface BuilderSkill {
  /** Globally unique slug; the Builder agent references skills
   *  by this. */
  readonly slug: string;
  /** Semver-ish version string from the vendored bundle. */
  readonly version: string;
  /** SHA pinned at vendor time — recorded on
   *  `agent_runs.skills_used` so a later marketplace bump does
   *  not retroactively change what the build referenced. */
  readonly sha: string;
  /** Markdown body of the skill — the agent harness inlines
   *  this into the LLM prompt at composition time. */
  readonly body: string;
  /** One-line summary; surfaces in `list_workflow_templates`. */
  readonly summary?: string;
}

interface BuilderSkillFile {
  readonly slug: unknown;
  readonly version: unknown;
  readonly sha: unknown;
  readonly body: unknown;
  readonly summary?: unknown;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(HERE, "..", "vendor", "n8n-skills");

function loadVendoredSkills(): readonly BuilderSkill[] {
  const out: BuilderSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(VENDOR_DIR);
  } catch {
    return [];
  }
  for (const name of entries.sort()) {
    if (!name.endsWith(".json")) continue;
    const raw = readFileSync(join(VENDOR_DIR, name), "utf8");
    const parsed = JSON.parse(raw) as BuilderSkillFile;
    if (
      typeof parsed.slug !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.sha !== "string" ||
      typeof parsed.body !== "string"
    ) {
      throw new Error(
        `vendor/n8n-skills/${name}: malformed BuilderSkill (slug/version/sha/body)`,
      );
    }
    const skill: BuilderSkill = {
      slug: parsed.slug,
      version: parsed.version,
      sha: parsed.sha,
      body: parsed.body,
      ...(typeof parsed.summary === "string"
        ? { summary: parsed.summary }
        : {}),
    };
    out.push(skill);
  }
  return out;
}

/** Static catalog — read once at module load. */
export const builderSkills: readonly BuilderSkill[] = loadVendoredSkills();
