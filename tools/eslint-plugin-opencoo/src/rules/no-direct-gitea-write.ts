import { createRule } from "../utils/create-rule.js";

export interface NoDirectGiteaWriteOptions {
  allowedPaths?: string[];
}

type MessageIds = "directGiteaWrite";

const DEFAULT_ALLOWED_PATHS = [
  "packages/shared/wiki-write/**",
  "packages/cli/src/provision/**",
];

export const noDirectGiteaWrite = createRule<
  [NoDirectGiteaWriteOptions],
  MessageIds
>({
  name: "no-direct-gitea-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "Gitea API clients must not be imported outside packages/shared/wiki-write (THREAT-MODEL.md §2 invariant 2).",
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
      directGiteaWrite:
        "Import Gitea clients only inside packages/shared/wiki-write; route writes through that module instead of '{{source}}'.",
    },
  },
  defaultOptions: [{ allowedPaths: DEFAULT_ALLOWED_PATHS }],
  create: () => ({}),
});
