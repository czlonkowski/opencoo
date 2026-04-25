/**
 * Credential schema for the n8n MCP automation adapter
 * (PR 25 / plan #120).
 *
 * The adapter resolves the n8n REST API token at deployWorkflow
 * time via the CredentialStore — the schema field below is what
 * the Management UI renders so the operator can paste a token
 * once. `secret: true` makes the UI mask input on entry and
 * never echo the value back from the server.
 *
 * The schema deliberately has NO activation field, NO enabled
 * flag, NO toggle knob — Gate 3 (THREAT-MODEL §2 invariant 7)
 * forbids any operator-visible activation surface.
 */
import type { OutputCredentialSchema } from "@opencoo/shared/output-adapter";

export const n8nMcpCredentialSchema: OutputCredentialSchema = {
  type: "object",
  properties: {
    n8nApiToken: {
      type: "string",
      description:
        "n8n REST API token. Generate via the n8n UI — Settings → API → Create API key. Required scope: workflows:create.",
      secret: true,
    },
  },
  required: ["n8nApiToken"],
};
