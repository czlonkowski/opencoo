import { createRule } from "../utils/create-rule.js";
import { importSourceVisitor } from "../utils/import-source-visitor.js";
import { pathMatchesAny } from "../utils/path-matcher.js";

export interface NoDirectGiteaWriteOptions {
  allowedPaths?: string[];
}

type MessageIds = "directGiteaWrite";

const DEFAULT_ALLOWED_PATHS = [
  "packages/shared/src/wiki-write/**",
  "packages/cli/src/provision/**",
  // The wiki-gitea adapter is the second sanctioned write path — its
  // job IS to talk to Gitea. wikiWrite() in @opencoo/shared still owns
  // orchestration (queue, delete-cap, retries); this adapter owns
  // the actual transport. THREAT-MODEL §2 invariant 2 stays intact:
  // every Gitea-touching import lives in one of these named places.
  "packages/adapters/wiki-gitea/**",
];

// Forbidden package names — direct Gitea clients.
const FORBIDDEN_PACKAGES = new Set([
  "@opencoo/gitea-client",
  "gitea-js",
  "@opencoo/wiki-gitea",
]);

// Forbidden path fragments — importing wiki-gitea adapter source directly.
const FORBIDDEN_PATH_FRAGMENTS = [
  "packages/adapters/wiki-gitea/",
  "/adapters/wiki-gitea/",
];

function isForbiddenSource(source: string): boolean {
  if (FORBIDDEN_PACKAGES.has(source)) return true;
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (source.startsWith(`${pkg}/`)) return true;
  }
  return FORBIDDEN_PATH_FRAGMENTS.some((f) => source.includes(f));
}

export const noDirectGiteaWrite = createRule<
  [NoDirectGiteaWriteOptions],
  MessageIds
>({
  name: "no-direct-gitea-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "Gitea API clients must not be imported outside the three sanctioned sites: the wiki-write orchestrator (packages/shared/src/wiki-write/**), the wiki-gitea adapter (packages/adapters/wiki-gitea/**), and the cli provisioning path (packages/cli/src/provision/**). THREAT-MODEL.md §2 invariant 2.",
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
        "Import Gitea clients only from the wiki-write orchestrator (packages/shared/src/wiki-write/**), the wiki-gitea adapter (packages/adapters/wiki-gitea/**), or cli provisioning (packages/cli/src/provision/**); route writes through wiki-write instead of importing '{{source}}' directly.",
    },
  },
  defaultOptions: [{ allowedPaths: DEFAULT_ALLOWED_PATHS }],
  create(context, [options]) {
    const allowedPaths = options.allowedPaths ?? DEFAULT_ALLOWED_PATHS;
    if (pathMatchesAny(context.filename, allowedPaths)) {
      return {};
    }

    return importSourceVisitor((node, source) => {
      if (isForbiddenSource(source)) {
        context.report({
          node,
          messageId: "directGiteaWrite",
          data: { source },
        });
      }
    });
  },
});
