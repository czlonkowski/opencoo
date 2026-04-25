/**
 * `AutomationAdapter` — port for materialising an approved
 * automation_candidate's `Proposal` as a deployed (NOT
 * activated) n8n workflow.
 *
 * # GATE 3 — TYPE-LEVEL ENFORCEMENT (THREAT-MODEL §2 invariant 7)
 *
 * The Builder agent uses ONLY the methods declared on this
 * interface. The interface intentionally has NO `activate`,
 * `enable`, `toggle`, or `setActive` method. If you find
 * yourself adding one — STOP — that's a Gate 3 bypass and the
 * entire 3-gate review loop becomes meaningless.
 *
 * Activation is and remains a manual operator action in the
 * n8n UI on a workflow the Builder has already deployed.
 * There is no admin toggle, no env var, no CLI override.
 *
 * The complementary defenses:
 * - PROMPT (en-builder.ts / pl-builder.ts) tells the LLM
 *   never to mention activation.
 * - SOURCE-GREP test on `builder/run.ts` for the literal
 *   `'activated'` — belt-and-suspenders against an inline
 *   string that bypasses the type system.
 *
 * v0.1 ships:
 *   - port shape (this file)
 *   - `InMemoryAutomationAdapter` (test fixture)
 *
 * Production wires `N8nAutomationAdapter` (PR 23+) which
 * speaks the n8n REST API for `deployWorkflow` only.
 */
import type {
  Proposal,
  SkillsUsed,
} from "@opencoo/shared/db";

export interface DeployWorkflowArgs {
  /** Slug of the n8n template to instantiate. The template
   *  itself lives in n8n; the adapter just wires params into
   *  it and POSTs `/workflows`. */
  readonly templateSlug: string;
  /** Per-template parameters resolved by the Builder LLM call.
   *  Validated upstream; the adapter passes them verbatim to
   *  n8n. */
  readonly resolvedParams: Proposal["params"];
  /** Snapshot of which skill bundles fed this build. The
   *  adapter persists this on the deployment row at write
   *  time — bumping a marketplace skill's version later does
   *  not retroactively change what was built. v0.1 happy path
   *  is `[]`; populate when the build referenced overlay /
   *  vendored skills. */
  readonly skillsUsed: SkillsUsed;
}

export interface DeployWorkflowResult {
  /** n8n's workflow id (string in the n8n REST API). The
   *  Builder persists this in `automation_deployments.n8n_workflow_id`.
   *  Forms the unique key on that row. */
  readonly n8nWorkflowId: string;
}

/**
 * Port. The interface has EXACTLY ONE method — `deployWorkflow`.
 * Adding any of {activate, enable, toggle, setActive,
 * makeActive, run, trigger, fire} would be a Gate 3 violation.
 *
 * The contract test in `engine-self-operating/tests/automation-adapter/
 * gate-3.test.ts` pins the keys on the interface against an
 * allow-list — adding one fails CI even if a reviewer doesn't
 * notice the new method by eye.
 */
export interface AutomationAdapter {
  deployWorkflow(args: DeployWorkflowArgs): Promise<DeployWorkflowResult>;
}
