/**
 * Credential-schema registry for the six wired SourceAdapters
 * (architecture.md §13 — UI dynamic form rendering, §10 adapter
 * boundaries).
 *
 * The Management UI's `+ New binding` modal looks up a slug,
 * reads the descriptor, and renders the form. The
 * `POST /api/admin/source-bindings` route looks up the same
 * descriptor and validates the submitted credentials before
 * passing them to credentialStore.write — server and UI share
 * one source of truth.
 *
 * Two modes:
 *   - 'polling' — flat top-level schema; one
 *     `credentialStore.write({plaintext: JSON})` call;
 *     `sources_bindings.credentials_id` set, `webhook_secret_credentials_id`
 *     stays null.
 *   - 'webhook' — top-level keys are exactly 'auth' and
 *     'webhook_secret'. The route splits them, encrypts each
 *     half via its own `credentialStore.write` call, and
 *     populates BOTH binding columns.
 *
 * Hardcoding adapter-specific UI is forbidden by CLAUDE.md
 * "the management UI renders the config form dynamically from
 * the schema". Adding a new adapter requires:
 *   1. Adding the slug to `SourceAdapterSlug` (and the CLI
 *      registry in packages/cli/src/bin.ts).
 *   2. Adding a descriptor here.
 * No UI change.
 */

/** Stable slug literal for the six adapters wired in v0.1 — must
 *  stay in sync with the CLI's adapter-registry list
 *  (`packages/cli/src/bin.ts`). The TypeScript narrowness here
 *  is intentional: a new adapter must touch this set AND the CLI
 *  wiring AND the UI in the same PR.
 *
 *  `webhook` is the generic inbound webhook adapter (PR-I); `okf` is
 *  the local Open Knowledge Format bundle reader (PR-OKF3b). */
export type SourceAdapterSlug =
  | "drive"
  | "asana"
  | "n8n"
  | "fireflies"
  | "webhook"
  | "okf";

/** JSON-Schema field shape — narrow subset matching the
 *  Management UI's CredentialForm expectations. Adding richer
 *  field types (boolean, enum, …) lands when the UI grows
 *  the corresponding renderer. */
export interface CredentialSchemaField {
  readonly type: "string";
  readonly description?: string;
  /** Field is encrypted at rest + masked in the UI form. */
  readonly secret?: boolean;
}

/** Polling-mode schema — flat properties map. */
export interface PollingCredentialSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CredentialSchemaField>>;
  readonly required: readonly string[];
}

/** Webhook-mode schema — split into `auth` + `webhook_secret`
 *  halves, each its own polling-style sub-schema. */
export interface WebhookCredentialSchema {
  readonly type: "object";
  readonly properties: {
    readonly auth: PollingCredentialSchema;
    readonly webhook_secret: PollingCredentialSchema;
  };
  readonly required: readonly ("auth" | "webhook_secret")[];
}

/** Discriminated union — `mode` narrows `credentialSchema`. */
export type SourceAdapterCredentialDescriptor =
  | {
      readonly mode: "polling";
      readonly credentialSchema: PollingCredentialSchema;
    }
  | {
      readonly mode: "webhook";
      readonly credentialSchema: WebhookCredentialSchema;
    };

const driveDescriptor = {
  mode: "polling",
  credentialSchema: {
    type: "object",
    properties: {
      service_account_json: {
        type: "string",
        description:
          "Google service-account JSON key for the folder root. Paste the full file contents.",
        secret: true,
      },
      root_folder_id: {
        type: "string",
        description: "Drive folder id the Scanner roots its scan at.",
      },
    },
    required: ["service_account_json", "root_folder_id"],
  },
} as const satisfies SourceAdapterCredentialDescriptor;

const n8nDescriptor = {
  mode: "polling",
  credentialSchema: {
    type: "object",
    properties: {
      api_token: {
        type: "string",
        description: "n8n REST API token (Settings → API).",
        secret: true,
      },
      base_url: {
        type: "string",
        description: "Base URL of the n8n instance, e.g. https://n8n.example.com.",
      },
    },
    required: ["api_token", "base_url"],
  },
} as const satisfies SourceAdapterCredentialDescriptor;

const asanaDescriptor = {
  mode: "webhook",
  credentialSchema: {
    type: "object",
    properties: {
      auth: {
        type: "object",
        properties: {
          personal_access_token: {
            type: "string",
            description: "Asana PAT used by the receiver to look up event details.",
            secret: true,
          },
          workspace_gid: {
            type: "string",
            description: "Workspace gid this binding scans.",
          },
        },
        required: ["personal_access_token", "workspace_gid"],
      },
      webhook_secret: {
        type: "object",
        properties: {
          x_hook_secret: {
            type: "string",
            description:
              "X-Hook-Secret value Asana issued during webhook handshake; receiver verifies HMAC against it.",
            secret: true,
          },
        },
        required: ["x_hook_secret"],
      },
    },
    required: ["auth", "webhook_secret"],
  },
} as const satisfies SourceAdapterCredentialDescriptor;

const firefliesDescriptor = {
  mode: "webhook",
  credentialSchema: {
    type: "object",
    properties: {
      auth: {
        type: "object",
        properties: {
          api_key: {
            type: "string",
            description: "Fireflies API key the receiver uses to fetch full transcripts.",
            secret: true,
          },
        },
        required: ["api_key"],
      },
      webhook_secret: {
        type: "object",
        properties: {
          signing_secret: {
            type: "string",
            description:
              "Fireflies webhook signing secret; receiver verifies HMAC against it.",
            secret: true,
          },
        },
        required: ["signing_secret"],
      },
    },
    required: ["auth", "webhook_secret"],
  },
} as const satisfies SourceAdapterCredentialDescriptor;

const webhookDescriptor = {
  mode: "webhook",
  credentialSchema: {
    type: "object",
    properties: {
      auth: {
        type: "object",
        properties: {},
        required: [],
      },
      webhook_secret: {
        type: "object",
        properties: {
          signing_secret: {
            type: "string",
            description:
              "HMAC-SHA256 signing secret. The sender must include `X-Signature: <hex>` on every POST; the receiver verifies HMAC against this value.",
            secret: true,
          },
        },
        required: ["signing_secret"],
      },
    },
    required: ["webhook_secret"],
  },
} as const satisfies SourceAdapterCredentialDescriptor;

/** OKF local-bundle reader (PR-OKF3b). A local OKF bundle has NO
 *  secret — the credential schema is empty. The adapter never resolves
 *  a credential; the (empty) descriptor exists only so the dynamic
 *  binding form + admin-API validator stay schema-driven for every
 *  slug (CLAUDE.md "the management UI renders the config form
 *  dynamically from the schema"). */
const okfDescriptor = {
  mode: "polling",
  credentialSchema: {
    type: "object",
    properties: {},
    required: [],
  },
} as const satisfies SourceAdapterCredentialDescriptor;

export const SOURCE_ADAPTER_CREDENTIAL_SCHEMAS: Readonly<
  Record<SourceAdapterSlug, SourceAdapterCredentialDescriptor>
> = {
  drive: driveDescriptor,
  asana: asanaDescriptor,
  n8n: n8nDescriptor,
  fireflies: firefliesDescriptor,
  webhook: webhookDescriptor,
  okf: okfDescriptor,
};

/** Type-narrowing helper. Returns `undefined` for unknown slugs
 *  rather than throwing — the route uses this to return a 422
 *  with a structured `unknown_adapter_slug` error. */
export function getSourceAdapterDescriptor(
  slug: string,
): SourceAdapterCredentialDescriptor | undefined {
  return (SOURCE_ADAPTER_CREDENTIAL_SCHEMAS as Record<string, SourceAdapterCredentialDescriptor>)[slug];
}
