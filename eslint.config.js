// Flat ESLint config (ESM) — opencoo §0 pre-coding gate.
// Wires typescript-eslint recommended rules + the four custom boundary
// rules defined by @opencoo/eslint-plugin over the active opencoo scope
// (packages/engine-*/, packages/shared/**, packages/adapters/**,
// packages/cli/**, packages/ui/**). packages/gitea-wiki-mcp-server/** is
// deliberately excluded — it ships as an independent npm package and
// keeps its own tsconfig/lint discipline.

import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";
import opencoo from "@opencoo/eslint-plugin";

const opencooScope = [
  "packages/engine-ingestion/**/*.{ts,tsx}",
  "packages/engine-self-operating/**/*.{ts,tsx}",
  "packages/shared/**/*.{ts,tsx}",
  "packages/adapters/**/*.{ts,tsx}",
  "packages/cli/**/*.{ts,tsx}",
  "packages/ui/**/*.{ts,tsx}",
];

const fixturesScope = ["tests/eslint-fixtures/**/*.{ts,tsx}"];

const tsLanguageOptions = {
  parser: tseslint.parser,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
};

// Boundary rules shared by the main opencoo scope and the fixture scope.
// Fixtures override no-cross-engine-import with appliesTo:"ingestion"
// because the fixture path is NOT under packages/engine-*/ so the
// auto-detect would miss it (see §4 below).
const boundaryRules = {
  "opencoo/no-cross-engine-import": "error",
  "opencoo/no-direct-gitea-write": "error",
  "opencoo/no-direct-llm-sdk": "error",
  "opencoo/no-feature-env-vars": "error",
  "opencoo/no-update-append-only": "error",
};

export default tseslint.config(
  // 1. Global ignores — subpackage, build artefacts, dependency tree.
  {
    ignores: [
      "packages/gitea-wiki-mcp-server/**",
      "tools/eslint-plugin-opencoo/dist/**",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      ".turbo/**",
    ],
  },

  // 2. typescript-eslint recommended for the opencoo scope.
  {
    files: opencooScope,
    extends: [...tseslint.configs.recommended],
    languageOptions: tsLanguageOptions,
  },

  // 3. Custom boundary rules over opencoo scope + import-x cycle guard.
  {
    files: opencooScope,
    plugins: { opencoo, "import-x": importX },
    rules: {
      ...boundaryRules,
      "import-x/no-cycle": ["error", { maxDepth: 10, ignoreExternal: true }],
    },
  },

  // 4. Fixtures block — parametrises no-cross-engine-import so it fires on
  //    the fixture path (which is NOT under packages/engine-*/ so the
  //    auto-detect would miss). Default to ingestion-direction; the
  //    self-op-direction fixture overrides via block 4b below.
  {
    files: fixturesScope,
    ignores: [
      "tests/eslint-fixtures/no-cross-engine-import-selfop.fixture.ts",
    ],
    plugins: { opencoo },
    languageOptions: tsLanguageOptions,
    rules: {
      ...boundaryRules,
      "opencoo/no-cross-engine-import": ["error", { appliesTo: "ingestion" }],
    },
  },

  // 4b. Self-op-direction fixture for no-cross-engine-import (PR 18 /
  //     plan #82 Q12). Same shape as block 4 but with
  //     appliesTo:'self-operating' so the rule fires on a hypothetical
  //     engine-self-operating file reaching INTO @opencoo/engine-ingestion.
  {
    files: ["tests/eslint-fixtures/no-cross-engine-import-selfop.fixture.ts"],
    plugins: { opencoo },
    languageOptions: tsLanguageOptions,
    rules: {
      ...boundaryRules,
      "opencoo/no-cross-engine-import": [
        "error",
        { appliesTo: "self-operating" },
      ],
    },
  },

  // 5. Adapter contract-test files legitimately read their OWN sidecar
  //    URL from process.env to gate the real-service tier (e.g.
  //    `DOCLING_URL` for converter-docling, `PANDOC_URL` for a future
  //    converter-pandoc). These URLs are NOT opencoo feature config —
  //    production code receives them at construction time from the
  //    routing layer; they only appear in tests. Scoped narrowly so
  //    adapter *production* code (packages/adapters/*/src/**) is still
  //    subject to the full allow-list.
  {
    files: ["packages/adapters/*/tests/**/*.{ts,tsx}"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },

  // 6. Classifier injection-corpus driver legitimately reads the
  //    `RUN_REAL_LLM` / `OPENROUTER_API_KEY` / `RUN_REAL_LLM_MODEL`
  //    env vars to gate the optional real-LLM tier of the corpus
  //    sweep — same shape as rule 5 for adapter sidecar URLs. The
  //    flags are CI/dev-only; no production code path reads them.
  //    Scoped narrowly to the single corpus driver so other tests
  //    in engine-ingestion remain subject to the allow-list.
  {
    files: ["packages/engine-ingestion/tests/classifier/injection.test.ts"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },

  // 7. Real-LLM integration test files (`*.real-llm.test.ts`) read
  //    `RUN_REAL_LLM` (gate flag — `=== '1'` skips the test in CI)
  //    and `OPENROUTER_API_KEY` (provider credential). These are
  //    CI/dev-only; no production code path touches them. The
  //    `*.real-llm.test.ts` pattern is the canonical gating
  //    convention: describe.skipIf(!RUN_REAL_LLM) wraps the suite,
  //    so CI never calls the real provider. First use: PR-F
  //    (source-asana Light-summary); future real-LLM tests follow
  //    the same file-naming pattern and are covered here
  //    automatically. See DECISIONS.md for the rationale entry.
  {
    files: ["**/*.real-llm.test.ts"],
    rules: {
      "opencoo/no-feature-env-vars": "off",
    },
  },
);
