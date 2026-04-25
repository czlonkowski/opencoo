/**
 * LLM-policy edit endpoints (PR 29 / plan #131, decision Q4 —
 * paired with the UI tab).
 *
 *   POST /api/admin/domains/:id/llm-policy/preview
 *     Body: `{proposed: <new llm_policy>}`.
 *     Returns: server-computed diff + sovereignty token
 *     (PR 28 primitives). 5-minute TTL.
 *
 *   POST /api/admin/domains/:id/llm-policy/apply
 *     Body: `{proposed: <same as preview>, token: <issued by preview>}`.
 *     Verifies the token (sig + payloadHash bound to
 *     domainId+proposed); rejects with 403/422 on:
 *       - signature_mismatch (token tampered)
 *       - expired (token > 5 min)
 *       - payload_mismatch (proposed changed since preview)
 *       - malformed (wrong segment count)
 *     On success: UPDATE domains SET llm_policy = …, audit-log
 *     row, return `{ok:true}`.
 *
 * Both routes require `verifyAdmin` (preHandler chain) +
 * `requireCsrf` for the state-changing apply step.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { writeAuditLog, type AuditAction } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";
import {
  computePayloadHash,
  issueSovereigntyDiffToken,
  verifySovereigntyDiffToken,
} from "../sovereignty-token.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const previewSchema = z
  .object({
    proposed: z.unknown(),
  })
  .strict();

const applySchema = z
  .object({
    proposed: z.unknown(),
    token: z.string().min(1),
  })
  .strict();

interface DiffEntry {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * Compute a flat top-level diff between two policies. v0.1
 * doesn't support nested-object diffing — the LLM policy at
 * `domains.llm_policy` is a flat record of `(tier-or-feature)
 * → {provider, model, key}` so a top-level walk is sufficient.
 * A nested diff lands in v0.2 if the policy shape grows.
 */
function flatDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ReadonlyArray<DiffEntry> {
  const keys = new Set<string>([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  const out: DiffEntry[] = [];
  for (const k of [...keys].sort()) {
    const b = before[k];
    const a = after[k];
    const bj = JSON.stringify(b);
    const aj = JSON.stringify(a);
    if (bj !== aj) {
      out.push({ path: k, before: b ?? null, after: a ?? null });
    }
  }
  return out;
}

export interface RegisterDomainsLlmPolicyRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly sessionHmacKey: Buffer;
}

export function registerDomainsLlmPolicyRoutes(
  args: RegisterDomainsLlmPolicyRoutesArgs,
): void {
  // Preview: server-canonical diff + token.
  args.app.post(
    "/api/admin/domains/:id/llm-policy/preview",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const parseResult = previewSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "validation_failed",
          issues: parseResult.error.issues,
        });
      }
      const { proposed } = parseResult.data;

      const result = (await args.db.execute(sql`
        SELECT llm_policy FROM domains WHERE id = ${id}::uuid
      `)) as unknown as { rows: Array<{ llm_policy: Record<string, unknown> }> };
      const row = result.rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      const before = row.llm_policy ?? {};
      const after =
        typeof proposed === "object" && proposed !== null && !Array.isArray(proposed)
          ? (proposed as Record<string, unknown>)
          : {};
      const diff = flatDiff(before, after);
      const { token, expiresAt } = issueSovereigntyDiffToken({
        key: args.sessionHmacKey,
        payload: { domainId: id, proposed: after },
      });
      return reply.code(200).send({ diff, token, expiresAt });
    },
  );

  // Apply: verify token + UPDATE + audit.
  args.app.post(
    "/api/admin/domains/:id/llm-policy/apply",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const id = (req.params as { id: string }).id;
      const parseResult = applySchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "validation_failed",
          issues: parseResult.error.issues,
        });
      }
      const { proposed, token } = parseResult.data;

      const after =
        typeof proposed === "object" && proposed !== null && !Array.isArray(proposed)
          ? (proposed as Record<string, unknown>)
          : {};

      const verifyResult = verifySovereigntyDiffToken({
        key: args.sessionHmacKey,
        token,
        currentPayload: { domainId: id, proposed: after },
      });
      if (!verifyResult.ok) {
        // Distinct status codes per failure mode for the UI:
        //   - expired / payload_mismatch → 422 (operator must
        //     re-preview); the response body's `reason` lets
        //     the UI render structured copy.
        //   - signature_mismatch / malformed → 403 (caller
        //     fabricated a token).
        const code =
          verifyResult.reason === "signature_mismatch" ||
          verifyResult.reason === "malformed"
            ? 403
            : 422;
        return reply.code(code).send({
          error: "sovereignty_token_invalid",
          reason: verifyResult.reason,
        });
      }

      const proposedJson = JSON.stringify(after);
      const updated = await args.db.execute(sql`
        UPDATE domains
        SET llm_policy = ${proposedJson}::jsonb,
            updated_at = NOW()
        WHERE id = ${id}::uuid
        RETURNING id::text AS id
      `) as unknown as { rows: Array<{ id: string }> };
      const row = updated.rows[0];
      if (row === undefined) {
        return reply.code(404).send({ error: "not_found", id });
      }

      // Audit-log row written BEFORE response. Action is
      // sourced from the writer's allow-list — adding it to
      // `AUDIT_LOG_ACTIONS` happens in the same PR.
      const action: AuditAction = "domain.llm_policy.apply";
      await writeAuditLog(args.db, {
        action,
        userId: ctx.userId,
        metadata: {
          domain_id: id,
          payload_hash: computePayloadHash({ domainId: id, proposed: after }),
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(200).send({ ok: true, id });
    },
  );
}
