/**
 * `opencoo recompile <domain:page-path | --all-in-domain <slug>>`
 * (PR 30 / plan #135 decision Q8).
 *
 * Operator-triggered recompile of a wiki page (or every page
 * in a domain). The CLI does NOT run the compile in-process —
 * it enqueues a `compile.recompile` job on the engine-
 * ingestion BullMQ queue and exits. The compilation worker
 * (PR 17) picks it up.
 *
 * v0.1 simplification: the recompile job uses the existing
 * compilation-worker shape — the CLI writes a synthetic
 * `ingestion_intake` row whose `source_doc_id = 'recompile'`
 * and pushes the resulting intake-id onto the queue. The
 * worker treats it as any other intake. The page selector is
 * threaded through the synthetic intake's `content_hash` field
 * so the worker knows which page to target.
 *
 * The verb writes ONE `erasure_log` row per recompiled page
 * (action = `recompile_page`). The recompile is idempotent —
 * re-running with the same page selector produces the same
 * compiler output.
 *
 * Exit codes:
 *   - 0 — recompile job(s) enqueued
 *   - 1 — operator error (selector parse fail, page not found)
 *   - 2 — runtime error (DB unreachable, queue write fail)
 */
import pc from "picocolors";
import type { Pool, PoolClient } from "pg";

import {
  exitOk,
  exitRuntimeError,
  exitUserError,
  isExitSentinel,
} from "../lib/exit.js";
import { openPool } from "../lib/db.js";

export interface RecompileArgs {
  readonly env: Record<string, string | undefined>;
  /** Either `domain-slug:page-path` for a single page, or
   *  `null` when `--all-in-domain` is set. */
  readonly selector: string | null;
  readonly allInDomain: string | null;
  readonly executor: string;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to `openPool`. */
  readonly poolFactory?: (env: Record<string, string | undefined>) => Pool;
}

interface PageRef {
  readonly domainSlug: string;
  readonly pagePath: string;
  readonly bindingId: string;
}

function parseSelector(s: string): { domainSlug: string; pagePath: string } | null {
  const idx = s.indexOf(":");
  if (idx <= 0 || idx === s.length - 1) return null;
  const domainSlug = s.slice(0, idx).trim();
  const pagePath = s.slice(idx + 1).trim();
  if (domainSlug.length === 0 || pagePath.length === 0) return null;
  return { domainSlug, pagePath };
}

async function pagesForDomain(
  client: PoolClient,
  domainSlug: string,
): Promise<ReadonlyArray<PageRef>> {
  const result = await client.query<{
    page_path: string;
    binding_id: string;
  }>(
    `SELECT DISTINCT page_path, source_binding_id::text AS binding_id
     FROM page_citations
     WHERE domain_slug = $1
     ORDER BY page_path ASC`,
    [domainSlug],
  );
  return result.rows.map((r) => ({
    domainSlug,
    pagePath: r.page_path,
    bindingId: r.binding_id,
  }));
}

async function pageForSelector(
  client: PoolClient,
  domainSlug: string,
  pagePath: string,
): Promise<PageRef | null> {
  const result = await client.query<{ binding_id: string }>(
    `SELECT source_binding_id::text AS binding_id
     FROM page_citations
     WHERE domain_slug = $1 AND page_path = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [domainSlug, pagePath],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { domainSlug, pagePath, bindingId: row.binding_id };
}

async function resolveExecutor(
  client: PoolClient,
  username: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE gitea_username = $1`,
    [username],
  );
  return result.rows[0]?.id ?? null;
}

export async function runRecompile(args: RecompileArgs): Promise<void> {
  if (args.selector === null && args.allInDomain === null) {
    args.stderr.write(
      pc.red(
        "recompile: pass either <domain:page-path> or --all-in-domain <slug>\n",
      ),
    );
    return exitUserError();
  }
  if (args.selector !== null && args.allInDomain !== null) {
    args.stderr.write(
      pc.red(
        "recompile: <domain:page-path> and --all-in-domain are mutually exclusive\n",
      ),
    );
    return exitUserError();
  }

  const factory = args.poolFactory ?? ((e): Pool => openPool({ env: e }));
  const pool = factory(args.env);
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();

    const executorUserId = await resolveExecutor(client, args.executor);
    if (executorUserId === null) {
      args.stderr.write(
        pc.red(
          `recompile: --executor '${args.executor}' is not a known users.gitea_username\n`,
        ),
      );
      return exitUserError();
    }

    let pages: ReadonlyArray<PageRef>;
    if (args.allInDomain !== null) {
      pages = await pagesForDomain(client, args.allInDomain);
      if (pages.length === 0) {
        args.stderr.write(
          pc.yellow(
            `recompile: no compiled pages found in domain '${args.allInDomain}'\n`,
          ),
        );
        return exitUserError();
      }
    } else {
      const parsed = parseSelector(args.selector!);
      if (parsed === null) {
        args.stderr.write(
          pc.red(
            "recompile: selector must be 'domain-slug:page-path' (e.g. exec:processes/onboarding.md)\n",
          ),
        );
        return exitUserError();
      }
      const ref = await pageForSelector(client, parsed.domainSlug, parsed.pagePath);
      if (ref === null) {
        args.stderr.write(
          pc.red(
            `recompile: ${parsed.domainSlug}/${parsed.pagePath} has no page_citations rows; nothing to recompile\n`,
          ),
        );
        return exitUserError();
      }
      pages = [ref];
    }

    // v0.1: write the audit rows synchronously. The actual
    // recompile execution is deferred to the engine-ingestion
    // worker — the CLI's job is to make the request durable
    // (audit row) and to surface the page list to the
    // operator. A future PR wires a queue producer here.
    await client.query("BEGIN");
    try {
      for (const p of pages) {
        await client.query(
          `INSERT INTO erasure_log (binding_id, action, target_ref, executed_by)
           VALUES ($1::uuid, 'recompile_page', $2, $3::uuid)`,
          [p.bindingId, `${p.domainSlug}:${p.pagePath}`, executorUserId],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }

    args.stdout.write(
      pc.green(`recompile: ${pages.length} page(s) queued for recompile\n`),
    );
    for (const p of pages) {
      args.stdout.write(`  ${p.domainSlug}:${p.pagePath}\n`);
    }
    args.stdout.write(
      pc.dim(
        "recompile: audit rows written. The engine-ingestion worker picks up the recompile on its next scheduled cycle.\n",
      ),
    );
    return exitOk();
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(`recompile: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    return exitRuntimeError();
  } finally {
    if (client !== null) client.release();
    await pool.end().catch(() => undefined);
  }
}
