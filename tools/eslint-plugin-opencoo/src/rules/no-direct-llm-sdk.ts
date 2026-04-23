import { createRule } from "../utils/create-rule.js";

export interface NoDirectLlmSdkOptions {
  allowedPaths?: string[];
}

type MessageIds = "directLlmSdk";

const DEFAULT_ALLOWED_PATHS = ["packages/shared/llm-router/**"];

export const noDirectLlmSdk = createRule<
  [NoDirectLlmSdkOptions],
  MessageIds
>({
  name: "no-direct-llm-sdk",
  meta: {
    type: "problem",
    docs: {
      description:
        "Vercel AI SDK and provider SDKs may only be imported inside packages/shared/llm-router (THREAT-MODEL.md §2 invariant 5).",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          allowedPaths: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    ],
    messages: {
      directLlmSdk:
        "Import '{{source}}' is an LLM SDK; route all LLM calls through packages/shared/llm-router.",
    },
  },
  defaultOptions: [{ allowedPaths: DEFAULT_ALLOWED_PATHS }],
  create: () => ({}),
});
