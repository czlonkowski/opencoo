/**
 * Vitest setup file. Loads the repo-root `.env` into process.env
 * before any test runs, so `RUN_REAL_LLM=1 pnpm test:injection`
 * picks up `OPENROUTER_API_KEY` etc. without the user having to
 * `source .env` in their shell.
 *
 * The load is conditional: if `.env` doesn't exist (CI, fresh
 * clones, contributors who never opted into the real-LLM tier),
 * we skip silently. The corpus driver gates on RUN_REAL_LLM=1
 * and surfaces a clear error if OPENROUTER_API_KEY is empty
 * when the flag is set.
 *
 * No production code path reads `.env`. This setup is test-only.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// tests/setup.ts → tests → packages/engine-ingestion → packages → repo
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DOTENV_PATH = resolve(REPO_ROOT, ".env");

if (existsSync(DOTENV_PATH)) {
  loadDotenv({ path: DOTENV_PATH, quiet: true });
}
