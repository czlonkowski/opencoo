/**
 * Review Dashboard — domains routes (PR 29 read-only listing +
 * phase-a appendix #2 create handler).
 *
 * `GET /api/admin/domains` — list rows for the Domains tab and
 *   the LLM Policy editor's per-domain picker.
 * `POST /api/admin/domains` — create a new domain. Closes
 *   PRD §5 #1 ("default domain without manual DB edits").
 *   Inserts the domains row inside a DB transaction; calls
 *   `provisionDomainRepo` to seed the Gitea repo. On
 *   provisioning failure the transaction rolls back — the
 *   operator never sees a half-created domain (no DB row + no
 *   audit row).
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { writeAuditLog } from "../audit-log.js";
import { requireAdminContext } from "../auth.js";
import { requireCsrf } from "../csrf.js";
import { extractOperatorPat } from "../pat.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Slug regex pinned to the Postgres `domains_slug_format`
 *  CHECK constraint (`^[a-z][a-z0-9-]{1,62}$`). Validating in
 *  the Zod parser surfaces a 422 before the DB INSERT — better
 *  diagnostics than a Postgres constraint-violation surface. */
const SLUG_REGEX = /^[a-z][a-z0-9-]{1,62}$/;

const DOMAIN_CLASSES = ["knowledge", "catalog-workflows", "catalog-skills"] as const;

const createDomainSchema = z
  .object({
    slug: z.string().regex(SLUG_REGEX),
    class: z.enum(DOMAIN_CLASSES),
    display_name: z.string().min(1).max(120),
    default_locale: z.enum(["en", "pl", "auto"]),
  })
  .strict();

/** Provisioning callable injected by the composition root.
 *  Carries the operator's PAT so Gitea writes happen as the
 *  caller (not a separate admin token). The PAT is request-
 *  lifetime ONLY — never persisted, never logged. */
export interface ProvisionDomainRepoFn {
  (args: {
    readonly slug: string;
    readonly domainClass: (typeof DOMAIN_CLASSES)[number];
    readonly defaultLocale: "en" | "pl" | "auto";
    readonly org: string;
    readonly pat: string;
  }): Promise<{ readonly repoUrl: string }>;
}

export interface RegisterDomainsRoutesArgs {
  readonly app: FastifyInstance;
  readonly db: Db;
  /** Phase-a appendix #2 — provisioning helper for the
   *  POST handler. The composition root supplies the real
   *  helper; tests inject a stub. */
  readonly provisionDomainRepo?: ProvisionDomainRepoFn;
  /** Gitea organisation that owns provisioned repos.
   *  Sourced from `GITEA_PROVISION_ORG` (default 'opencoo'). */
  readonly provisionOrg?: string;
}

export function registerDomainsRoutes(args: RegisterDomainsRoutesArgs): void {
  args.app.get("/api/admin/domains", async () => {
    const result = (await args.db.execute(sql`
      SELECT id::text AS id,
             slug,
             name,
             class::text AS class,
             locale,
             llm_policy,
             is_aggregator
      FROM domains
      ORDER BY slug ASC
    `)) as unknown as {
      rows: Array<{
        id: string;
        slug: string;
        name: string;
        class: string;
        locale: string;
        llm_policy: Record<string, unknown>;
        is_aggregator: boolean;
      }>;
    };
    return {
      rows: result.rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        class: r.class,
        locale: r.locale,
        llmPolicy: r.llm_policy,
        isAggregator: r.is_aggregator,
      })),
    };
  });

  // Phase-a appendix #2 — domain create.
  args.app.post(
    "/api/admin/domains",
    { preHandler: requireCsrf },
    async (req, reply) => {
      const ctx = requireAdminContext(req);
      const parsed = createDomainSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: "validation_failed",
          issues: parsed.error.issues,
        });
      }
      const { slug, class: domainClass, display_name, default_locale } = parsed.data;

      // Slug-collision guard BEFORE provisioning so we never
      // bother Gitea with a request that's destined to fail.
      const existing = (await args.db.execute(sql`
        SELECT 1 FROM domains WHERE slug = ${slug} LIMIT 1
      `)) as unknown as { rows: Array<unknown> };
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: "slug_taken", slug });
      }

      // Operator PAT — required for provisioning; the route
      // does not persist or log it.
      const operatorPat = extractOperatorPat(req);
      if (operatorPat === undefined) {
        // Should not reach here when verifyAdmin ran (it
        // already verified Bearer presence). Safety net.
        return reply.code(401).send({
          error: "unauthorized",
          reason: "missing_authorization_header",
        });
      }

      const provision = args.provisionDomainRepo;
      if (provision === undefined) {
        return reply.code(500).send({
          error: "provisioning_unavailable",
          reason:
            "Composition did not register a provisionDomainRepo handler",
        });
      }
      const provisionOrg = args.provisionOrg ?? "opencoo";

      // Transaction wraps the INSERT; provisioning happens
      // inside so a Gitea failure rolls back the partial row.
      let result: { readonly id: string; readonly repoUrl: string };
      try {
        result = await args.db.transaction(async (tx) => {
          const inserted = (await tx.execute(sql`
            INSERT INTO domains (slug, name, class, locale)
            VALUES (${slug}, ${display_name}, ${sql.raw(`'${domainClass}'`)}::domain_class, ${default_locale})
            RETURNING id::text AS id
          `)) as unknown as { rows: Array<{ id: string }> };
          const id = inserted.rows[0]?.id;
          if (id === undefined) {
            throw new Error("INSERT into domains returned no row");
          }

          // Provision Gitea repo as the caller. Failures throw
          // and roll back the INSERT.
          const provisionResult = await provision({
            slug,
            domainClass,
            defaultLocale: default_locale,
            org: provisionOrg,
            pat: operatorPat,
          });

          return { id, repoUrl: provisionResult.repoUrl };
        });
      } catch (err) {
        // The pre-check at line ~135 narrows the slug-collision
        // window but doesn't close it: two concurrent POSTs can
        // both pass the SELECT and race on the UNIQUE-constrained
        // INSERT. Postgres raises SQLSTATE 23505 (unique_violation);
        // surface that as 409 slug_taken so the operator sees the
        // same shape as the pre-check path, not 502 provisioning_failed.
        const pgCode =
          err !== null &&
          typeof err === "object" &&
          "code" in err &&
          typeof (err as { code?: unknown }).code === "string"
            ? (err as { code: string }).code
            : null;
        if (pgCode === "23505") {
          return reply.code(409).send({ error: "slug_taken", slug });
        }
        // Genuine provisioning failure (Gitea unreachable, seed-file
        // commit failed, etc.). PAT and upstream-message scrubbed —
        // engine logger captured the detail (gitea-provisioning helper
        // scrubs the PAT from its own thrown errors).
        req.log?.warn({
          msg: "domain_create.provisioning_failed",
          slug,
          err: err instanceof Error ? err.name : "unknown",
        });
        return reply.code(502).send({
          error: "provisioning_failed",
          slug,
        });
      }

      // Audit row AFTER successful tx commit. Metadata never
      // includes PAT bytes — only slug, class, repo url, caller.
      await writeAuditLog(args.db, {
        action: "domain.create",
        userId: ctx.userId,
        metadata: {
          slug,
          class: domainClass,
          repo_url: result.repoUrl,
          caller_username: ctx.username,
        },
        sourceIp: req.ip,
        userAgent: req.headers["user-agent"],
      });

      return reply.code(201).send({
        id: result.id,
        slug,
        repoUrl: result.repoUrl,
      });
    },
  );
}
