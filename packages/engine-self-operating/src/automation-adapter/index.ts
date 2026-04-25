/**
 * Public surface for the AutomationAdapter subsystem
 * (PR 21 / plan #102).
 *
 * GATE 3 LYNCHPIN — the interface here has NO activate/enable/
 * toggle method. Adding one bypasses the 3-gate review loop;
 * the contract test in tests/automation-adapter/gate-3.test.ts
 * pins the method-name allow-list at compile / test time.
 */
export {
  type AutomationAdapter,
  type DeployWorkflowArgs,
  type DeployWorkflowResult,
} from "./interface.js";

export {
  InMemoryAutomationAdapter,
  type CapturedDeployment,
} from "./in-memory.js";
