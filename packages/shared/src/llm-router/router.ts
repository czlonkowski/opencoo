import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  computeMonthToDateCost,
  costFor,
} from "../cost-tracker/index.js";
import type { DomainId } from "../db/brands.js";
import { domains } from "../db/schema/domains.js";
import { llmUsage } from "../db/schema/llm-usage.js";
import { llmUsageDebug } from "../db/schema/llm-usage-debug.js";
import type { Logger } from "../logger.js";
import {
  LlmBudgetExceededError,
  LlmPolicyViolationError,
  LlmProviderError,
} from "./errors.js";
import type {
  GenerateObjectOpts,
  GenerateObjectResult,
  GenerateOpts,
  GenerateTextResult,
  LlmProvider,
} from "./interface.js";
import { FALLBACK_POLICY, llmPolicySchema, type LlmPolicy } from "./llm-policy.js";
import type { QueuePauser } from "./queue-pauser.js";

export type LlmRouterDb = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>
>;

export interface LlmRouterOptions {
  readonly db: LlmRouterDb;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly pauser: QueuePauser;
  readonly provider: LlmProvider;
  readonly now?: () => Date;
}

interface DomainRow {
  id: DomainId;
  slug: string;
  llmPolicy: unknown;
  llmBudgetMonthlyCapUsd: string | null;
}

// Rough pre-call cost estimate used BEFORE the provider is invoked,
// so budget-cap can fail-closed without spending the token. We don't
// know the real tokens-in until after; the caller's prompt length
// + a 512-token response ceiling is a reasonable upper bound. The
// router refines the row with real counts after the call.
const TOKEN_CHAR_RATIO = 4; // ~4 chars/token for English; over-estimates for code
const RESPONSE_TOKEN_ESTIMATE = 512;

// Pre-check estimate intentionally passes no logger — the unknown-model
// warning fires exactly once per call, from `recordUsage`'s `costFor`.
function estimateCost(model: string, prompt: string): number {
  const tokensIn = Math.ceil(prompt.length / TOKEN_CHAR_RATIO);
  return costFor(model, tokensIn, RESPONSE_TOKEN_ESTIMATE);
}

export class LlmRouter {
  private readonly db: LlmRouterDb;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly pauser: QueuePauser;
  private readonly provider: LlmProvider;
  private readonly now: () => Date;

  constructor(options: LlmRouterOptions) {
    this.db = options.db;
    this.env = options.env;
    this.logger = options.logger;
    this.pauser = options.pauser;
    this.provider = options.provider;
    this.now = options.now ?? ((): Date => new Date());
  }

  async generateText(opts: GenerateOpts): Promise<GenerateTextResult> {
    const { policy, model } = await this.resolvePolicy(opts);
    await this.enforceBudget(opts, model);

    const startedAt = this.now().getTime();
    let tokensIn = 0;
    let tokensOut = 0;
    let text = "";
    let providerError: unknown = null;

    try {
      const response = await this.provider.generate({
        provider: policy[opts.tier].provider,
        model,
        prompt: opts.prompt,
      });
      text = response.text;
      tokensIn = response.tokensIn;
      tokensOut = response.tokensOut;
    } catch (err) {
      providerError = err;
    } finally {
      await this.recordUsage({
        opts,
        model,
        tokensIn,
        tokensOut,
        startedAt,
        endedAt: this.now().getTime(),
        debugResponseText: providerError === null ? text : "",
        debugEnabled: this.env["LLM_DEBUG_LOG"] === "1",
      });
    }

    if (providerError !== null) {
      if (providerError instanceof LlmProviderError) {
        throw providerError;
      }
      throw new LlmProviderError("provider call failed", {
        cause: providerError,
      });
    }

    return { text, tokensIn, tokensOut, model };
  }

  async generateObject<T>(
    opts: GenerateObjectOpts<T>,
  ): Promise<GenerateObjectResult<T>> {
    const result = await this.generateText(opts);
    let parsed: T;
    try {
      const raw = JSON.parse(result.text) as unknown;
      parsed = opts.schema.parse(raw) as T;
    } catch (err) {
      throw new LlmProviderError("structured output failed schema validation", {
        cause: err,
      });
    }
    return {
      object: parsed,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      model: result.model,
    };
  }

  private async loadDomain(domainId: DomainId): Promise<DomainRow> {
    const rows = await this.db
      .select({
        id: domains.id,
        slug: domains.slug,
        llmPolicy: domains.llmPolicy,
        llmBudgetMonthlyCapUsd: domains.llmBudgetMonthlyCapUsd,
      })
      .from(domains)
      .where(eq(domains.id, domainId));
    const row = rows[0];
    if (row === undefined) {
      throw new LlmPolicyViolationError(`domain ${domainId} not found`);
    }
    return {
      id: row.id as DomainId,
      slug: row.slug,
      llmPolicy: row.llmPolicy,
      llmBudgetMonthlyCapUsd: row.llmBudgetMonthlyCapUsd ?? null,
    };
  }

  private async resolvePolicy(
    opts: GenerateOpts,
  ): Promise<{ policy: LlmPolicy; model: string; row: DomainRow }> {
    const row = await this.loadDomain(opts.domainId);
    let policy: LlmPolicy;

    // An empty object {} is the "unconfigured" marker — fall back to
    // the bundled default. Anything else must parse as a full policy.
    const raw = row.llmPolicy;
    if (
      raw === null ||
      raw === undefined ||
      (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as Record<string, unknown>).length === 0)
    ) {
      policy = FALLBACK_POLICY;
      this.logger.warn("llm.policy.fallback", {
        domain_slug: row.slug,
        note: "domain.llm_policy is empty; using FALLBACK_POLICY. Configure via Management UI (PR 29).",
      });
    } else {
      const parsed = llmPolicySchema.safeParse(raw);
      if (!parsed.success) {
        throw new LlmPolicyViolationError(
          `domain ${row.slug} has malformed llm_policy`,
          { cause: parsed.error },
        );
      }
      policy = parsed.data;
    }

    const tierSpec = policy[opts.tier];
    if (policy.local_only && tierSpec.provider !== "ollama") {
      throw new LlmPolicyViolationError(
        `domain ${row.slug} is local_only but policy.${opts.tier}.provider = ${tierSpec.provider}`,
      );
    }

    return { policy, model: tierSpec.model, row };
  }

  private async enforceBudget(
    opts: GenerateOpts,
    model: string,
  ): Promise<void> {
    const row = await this.loadDomain(opts.domainId);
    if (row.llmBudgetMonthlyCapUsd === null) return; // unlimited

    const cap = Number.parseFloat(row.llmBudgetMonthlyCapUsd);
    const mtd = await computeMonthToDateCost(this.db, opts.domainId);
    const pre = estimateCost(model, opts.prompt);
    if (mtd + pre <= cap) return;

    await this.pauser.pauseDomainQueues(opts.domainId);
    await this.db.insert(llmUsage).values({
      timestamp: this.now(),
      engine: "ingestion",
      tier: opts.tier,
      model,
      pipelineOrAgent: "budget-cap-breach",
      domainId: opts.domainId,
      documentId: opts.documentId ?? null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: "0",
      latencyMs: 0,
    });
    this.logger.warn("llm.budget.breached", {
      domain_slug: row.slug,
      domain_id: opts.domainId,
      mtd_usd: mtd,
      estimated_next_usd: pre,
      cap_usd: cap,
    });
    throw new LlmBudgetExceededError(
      `domain ${row.slug} month-to-date $${mtd.toFixed(4)} + estimate $${pre.toFixed(4)} would exceed cap $${cap.toFixed(2)}`,
    );
  }

  private async recordUsage(args: {
    opts: GenerateOpts;
    model: string;
    tokensIn: number;
    tokensOut: number;
    startedAt: number;
    endedAt: number;
    debugResponseText: string;
    debugEnabled: boolean;
  }): Promise<void> {
    const cost = costFor(args.model, args.tokensIn, args.tokensOut, {
      logger: this.logger,
    });
    // Pre-generate the id so we can pair the debug-row FK without a
    // RETURNING roundtrip (pglite supports RETURNING but keeping the
    // wire simple helps when we swap in a thinner driver later).
    const usageId = crypto.randomUUID();
    await this.db.insert(llmUsage).values({
      id: sql`${usageId}::uuid`,
      timestamp: new Date(args.startedAt),
      engine: "ingestion",
      tier: args.opts.tier,
      model: args.model,
      pipelineOrAgent: args.opts.pipelineOrAgent,
      domainId: args.opts.domainId,
      documentId: args.opts.documentId ?? null,
      tokensIn: args.tokensIn,
      tokensOut: args.tokensOut,
      costUsd: cost.toFixed(6),
      latencyMs: args.endedAt - args.startedAt,
    });
    if (args.debugEnabled) {
      await this.db.insert(llmUsageDebug).values({
        usageId: sql`${usageId}::uuid`,
        promptText: args.opts.prompt,
        responseText: args.debugResponseText,
      });
    }
  }
}
