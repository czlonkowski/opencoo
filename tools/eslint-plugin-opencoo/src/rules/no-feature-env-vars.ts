import type { TSESTree } from "@typescript-eslint/utils";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../utils/create-rule.js";

export interface NoFeatureEnvVarsOptions {
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

function isIdentifier(
  node: TSESTree.Node,
  name: string,
): node is TSESTree.Identifier {
  return node.type === AST_NODE_TYPES.Identifier && node.name === name;
}

function isProcessEnv(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.MemberExpression &&
    !node.computed &&
    isIdentifier(node.object, "process") &&
    isIdentifier(node.property, "env")
  );
}

export const noFeatureEnvVars = createRule<
  [NoFeatureEnvVarsOptions],
  MessageIds
>({
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
  create(context, [options]) {
    const allowList = new Set(options.allowList ?? DEFAULT_ALLOW_LIST);

    return {
      MemberExpression(node): void {
        if (!isProcessEnv(node.object)) return;

        const property = node.property;
        let name: string | null = null;

        if (!node.computed) {
          if (property.type === AST_NODE_TYPES.Identifier) {
            name = property.name;
          }
        } else if (property.type === AST_NODE_TYPES.Literal) {
          if (typeof property.value === "string") {
            name = property.value;
          } else {
            // e.g. process.env[123] — bizarre but treat as dynamic
            context.report({ node, messageId: "dynamicAccess" });
            return;
          }
        } else if (
          property.type === AST_NODE_TYPES.TemplateLiteral &&
          property.expressions.length === 0 &&
          property.quasis.length === 1
        ) {
          // process.env[`DATABASE_URL`] — zero-interp template = literal
          const quasi = property.quasis[0];
          if (quasi !== undefined) {
            name = quasi.value.cooked;
          }
        } else {
          // any other computed expression is dynamic
          context.report({ node, messageId: "dynamicAccess" });
          return;
        }

        if (name === null) return;

        if (!allowList.has(name)) {
          context.report({
            node,
            messageId: "featureEnvVar",
            data: { name },
          });
        }
      },
    };
  },
});
