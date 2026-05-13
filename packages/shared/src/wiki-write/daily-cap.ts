import type { DomainSlug } from "../db/brands.js";

import { WikiWriteCapExceededError } from "./errors.js";

const DEFAULT_DAILY_LIMIT = 10;

// Per-domain daily delete counter. `reserve(slug, n, now)` commits
// `n` against the (slug, today) budget and throws when the total
// would exceed the configured limit. Date-based reset uses the ISO
// YYYY-MM-DD prefix from the injected clock (test-friendly).
//
// `peek(slug, now)` is read-only: returns the current `(used, cap)`
// for today without committing. Used by the source-forget impact
// preview (PR-R7) so the operator sees today's delete budget BEFORE
// confirming a destructive action. Reading does not mutate state and
// does not affect future `reserve` decisions.
export interface DeleteCapState {
  readonly used: number;
  readonly cap: number;
}

export interface DeleteCap {
  reserve(domainSlug: DomainSlug, count: number, now: Date): void;
  peek(domainSlug: DomainSlug, now: Date): DeleteCapState;
}

interface CounterEntry {
  isoDate: string;
  count: number;
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface InMemoryDeleteCapOptions {
  readonly dailyLimit?: number;
}

export class InMemoryDeleteCap implements DeleteCap {
  private readonly counts: Map<DomainSlug, CounterEntry> = new Map();
  private readonly dailyLimit: number;

  constructor(options: InMemoryDeleteCapOptions = {}) {
    this.dailyLimit = options.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  }

  reserve(domainSlug: DomainSlug, count: number, now: Date): void {
    const today = isoDate(now);
    const current = this.usedToday(domainSlug, today);
    const next = current + count;
    if (next > this.dailyLimit) {
      throw new WikiWriteCapExceededError(
        `wiki-write delete cap exceeded for ${domainSlug}: ${current}+${count} > ${this.dailyLimit} on ${today}`,
      );
    }
    this.counts.set(domainSlug, { isoDate: today, count: next });
  }

  peek(domainSlug: DomainSlug, now: Date): DeleteCapState {
    return { used: this.usedToday(domainSlug, isoDate(now)), cap: this.dailyLimit };
  }

  /** Today's used count for `domainSlug`, with the date-rollover
   *  reset baked in: a counter from a prior day reads as 0. */
  private usedToday(domainSlug: DomainSlug, today: string): number {
    const prior = this.counts.get(domainSlug);
    return prior === undefined || prior.isoDate !== today ? 0 : prior.count;
  }
}
