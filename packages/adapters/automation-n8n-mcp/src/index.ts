/**
 * Public surface for `@opencoo/automation-n8n-mcp` (PR 25 /
 * plan #120).
 *
 * AutomationAdapter implementation for n8n via the REST API.
 * Bundles a vendored snapshot of `czlonkowski/n8n-skills` so the
 * Builder agent has a stable BuilderSkill catalog at v0.1
 * without a runtime fetch dependency.
 *
 * Composition root (PR 38) wires:
 *   - the real n8n REST client behind `makeApi`,
 *   - the project's CredentialStore + the operator-bound
 *     credentialId for the `n8nApiToken` schema field,
 *   - the harness translation from BuilderToolDescriptor to
 *     MCP tool defs.
 *
 * Gate 3 (THREAT-MODEL §2 invariant 7) is preserved at four
 * layers — see `adapter.ts` for the full rationale.
 */
export {
  AUTOMATION_N8N_MCP_SLUG,
  createAutomationN8nMcpAdapter,
  n8nMcpCredentialSchema,
  type AutomationN8nMcpAdapter,
  type CreateAutomationN8nMcpAdapterArgs,
  type DeployWorkflowArgs,
  type DeployWorkflowResult,
  type MakeN8nApi,
} from "./adapter.js";

export {
  builderSkills,
  type BuilderSkill,
} from "./builder-skills.js";

export {
  tools,
  type BuilderToolDescriptor,
} from "./builder-tools.js";

export {
  n8nWorkflowBodySchema,
  type N8nApiError,
  type N8nApiHttpError,
  type N8nApiTransientError,
  type N8nCreateWorkflowArgs,
  type N8nCreateWorkflowResult,
  type N8nLikeApi,
  type N8nWorkflowBody,
} from "./n8n-api.js";
