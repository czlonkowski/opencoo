import { createRule } from "../utils/create-rule.js";

interface Options {
  allowList?: string[];
}

type MessageIds = "featureEnvVar" | "dynamicAccess";

const DEFAULT_ALLOW_LIST = [
  "DATABASE_URL",
  "DATABASE_URL_FILE",
  "ENCRYPTION_KEY",
  "ENCRYPTION_KEY_FILE",
  "PORT",
  "PORT_FILE",
  "ADMIN_BOOTSTRAP_TOKEN",
  "ADMIN_BOOTSTRAP_TOKEN_FILE",
  "NODE_ENV",
  "LLM_DEBUG_LOG",
  "TELEMETRY_ENDPOINT",
];

export const noFeatureEnvVars = createRule<[Options], MessageIds>({
  name: "no-feature-env-vars",
  meta: {
    type: "problem",
    docs: {
      description:
        "process.env access is restricted to the allow-list documented in .env.example (THREAT-MODEL.md §2 invariant 9; CLAUDE.md 'UI-first configuration').",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          allowList: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    ],
    messages: {
      featureEnvVar:
        "process.env.{{name}} is not in the allow-list. Move feature config into Postgres (UI-managed) or add it to .env.example + the rule allow-list with THREAT-MODEL.md §2 sign-off.",
      dynamicAccess:
        "Dynamic process.env access is forbidden — it bypasses the allow-list. Use a literal key from the allow-list.",
    },
  },
  defaultOptions: [{ allowList: DEFAULT_ALLOW_LIST }],
  create: () => ({}),
});
