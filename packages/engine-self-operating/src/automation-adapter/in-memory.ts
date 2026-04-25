/**
 * In-memory AutomationAdapter fixture for tests. Records every
 * `deployWorkflow` call + returns a deterministic generated
 * n8n workflow id so the test can assert the deployment row
 * was wired correctly.
 */
import type {
  AutomationAdapter,
  DeployWorkflowArgs,
  DeployWorkflowResult,
} from "./interface.js";

export interface CapturedDeployment {
  readonly templateSlug: string;
  readonly resolvedParams: DeployWorkflowArgs["resolvedParams"];
  readonly skillsUsed: DeployWorkflowArgs["skillsUsed"];
  readonly returnedWorkflowId: string;
}

export class InMemoryAutomationAdapter implements AutomationAdapter {
  private readonly captured: CapturedDeployment[] = [];
  private nextId = 1;

  get deployments(): readonly CapturedDeployment[] {
    return [...this.captured];
  }

  async deployWorkflow(
    args: DeployWorkflowArgs,
  ): Promise<DeployWorkflowResult> {
    const id = `n8n-wf-${this.nextId++}`;
    this.captured.push({
      templateSlug: args.templateSlug,
      resolvedParams: args.resolvedParams,
      skillsUsed: args.skillsUsed,
      returnedWorkflowId: id,
    });
    return { n8nWorkflowId: id };
  }

  reset(): void {
    this.captured.length = 0;
    this.nextId = 1;
  }
}
