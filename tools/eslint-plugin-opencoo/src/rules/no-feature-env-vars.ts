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
  // Standard CI env var — set by every CI provider and consumed
  // by test tooling (Playwright's `forbidOnly`, vitest's
  // reporter selection). PR 29.
  "CI",
  "LLM_DEBUG_LOG",
  "LOG_LEVEL",
  "TELEMETRY_ENDPOINT",
  // Engine-ingestion needs Redis (BullMQ) and Gitea (wiki transport)
  // URLs at boot. Both follow the existing `_FILE` Docker-secrets
  // convention used by DATABASE_URL_FILE / ENCRYPTION_KEY_FILE so
  // production deploys can stash credentials on tmpfs instead of env.
  "REDIS_URL",
  "REDIS_URL_FILE",
  "GITEA_URL",
  "GITEA_URL_FILE",
  // Engine-self-operating ships the Management UI as a bundled
  // SPA. UI_DIST_PATH points at the dist directory at boot;
  // _FILE variant follows the same Docker-secrets convention.
  // (PR 18, plan #82)
  "UI_DIST_PATH",
  "UI_DIST_PATH_FILE",
  // Admin-API auth + sovereignty-diff signing (PR 28 / plan #128,
  // THREAT-MODEL §3.13). All three follow the same Docker-secrets
  // _FILE convention so production deploys can stash credentials
  // on tmpfs instead of env.
  "ADMIN_TEAM_SLUG",
  "ADMIN_TEAM_SLUG_FILE",
  "SESSION_HMAC_KEY",
  "SESSION_HMAC_KEY_FILE",
  "GITEA_BASE_URL",
  "GITEA_BASE_URL_FILE",
  // CLI `doctor` team-check fallback (PR 30 / plan #135
  // decision Q12). When the operator doesn't pass `--admin-pat`,
  // doctor reads this env. Allow-listed because it's an
  // operator-provided secret with the same semantics as
  // ENCRYPTION_KEY etc. — but only the CLI consumes it;
  // engine procs never read it.
  "OPENCOO_ADMIN_PAT",
  "OPENCOO_ADMIN_PAT_FILE",
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

    function literalNameOfKey(
      key: TSESTree.Node,
      computed: boolean,
    ): string | null | "dynamic" {
      if (!computed) {
        if (key.type === AST_NODE_TYPES.Identifier) {
          return key.name;
        }
        if (
          key.type === AST_NODE_TYPES.Literal &&
          typeof key.value === "string"
        ) {
          return key.value;
        }
        return "dynamic";
      }
      if (key.type === AST_NODE_TYPES.Literal) {
        return typeof key.value === "string" ? key.value : "dynamic";
      }
      if (
        key.type === AST_NODE_TYPES.TemplateLiteral &&
        key.expressions.length === 0 &&
        key.quasis.length === 1
      ) {
        const quasi = key.quasis[0];
        return quasi?.value.cooked ?? "dynamic";
      }
      return "dynamic";
    }

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
      VariableDeclarator(node): void {
        if (node.id.type !== AST_NODE_TYPES.ObjectPattern) return;
        if (node.init === null || !isProcessEnv(node.init)) return;

        for (const prop of node.id.properties) {
          if (prop.type === AST_NODE_TYPES.RestElement) {
            // `const { ...rest } = process.env` exposes the full env object —
            // equivalent to dynamic access, can't be allow-list checked.
            context.report({ node: prop, messageId: "dynamicAccess" });
            continue;
          }

          const name = literalNameOfKey(prop.key, prop.computed);
          if (name === "dynamic") {
            context.report({ node: prop, messageId: "dynamicAccess" });
            continue;
          }
          if (name === null) continue;

          if (!allowList.has(name)) {
            context.report({
              node: prop,
              messageId: "featureEnvVar",
              data: { name },
            });
          }
        }
      },
    };
  },
});
