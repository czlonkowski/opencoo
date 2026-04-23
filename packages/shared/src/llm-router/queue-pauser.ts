import type { DomainId } from "../db/brands.js";

// Surface the budget-cap path calls when a domain breaches its cap.
// Production impl (PR 13) pauses the relevant BullMQ queues; the
// in-memory fixture used in tests just records the DomainId so
// assertions can verify the call shape.
export interface QueuePauser {
  pauseDomainQueues(domainId: DomainId): Promise<void>;
}

export class InMemoryQueuePauser implements QueuePauser {
  readonly pausedDomainIds: Set<DomainId> = new Set();

  async pauseDomainQueues(domainId: DomainId): Promise<void> {
    // Idempotent — a second pause call for the same domain is a no-op.
    this.pausedDomainIds.add(domainId);
  }
}
