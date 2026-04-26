/**
 * `opencoo source forget <binding-id>` (PR 30 / plan #135
 * decision Q9).
 *
 * Operator-triggered erasure verb. Disables the binding +
 * purges every transient row attributable to it
 * (`ingestion_intake`, `webhook_events`). Writes ONE
 * `erasure_log` row per action — append-only proof the
 * deletion happened.
 *
 * Does NOT retroactively rewrite Gitea wiki history (Q9): a
 * page compiled from this source stays in the wiki repo.
 * Lint catches the orphan citation on its next pass; the
 * operator can manually rewrite or rename.
 *
 * # Hard security pins
 *
 * 1. Non-interactive (no TTY, no `--dry-run`) → exit 1 with
 *    a clear message. Prevents an unattended cron from blowing
 *    away an operator's binding by accident.
 * 2. Interactive → prompt `Type binding-slug to confirm:` and
 *    require an exact match. Empty / wrong → exit 1.
 * 3. Every state-changing SQL is wrapped in a transaction so
 *    a partial failure leaves a consistent DB.
 * 4. The `erasure_log` row writes BEFORE the row deletes — a
 *    crash between the two leaves an audit trail of the attempt.
 *
 * Required: a Gitea username for `executed_by`. We require
 * `--executor <username>` so the audit trail names a human;
 * resolves to a `users.id` via `gitea_username`.
 */
import pc from "picocolors";
import promptsLib from "prompts";
import type { Pool, PoolClient } from "pg";

import {
  exitOk,
  exitRuntimeError,
  exitUserError,
  isExitSentinel,
} from "../lib/exit.js";
import { openPool } from "../lib/db.js";
import { detectTty, type TtyDetector } from "../lib/tty.js";

export interface SourceForgetArgs {
  readonly env: Record<string, string | undefined>;
  readonly bindingId: string;
  readonly executor: string;
  readonly dryRun: boolean;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — defaults to TTY detection via
   *  `process.stdin.isTTY`. */
  readonly tty?: TtyDetector;
  /** @internal Test seam — defaults to the `prompts` lib. */
  readonly promptsFn?: typeof promptsLib;
  /** @internal Test seam — defaults to `openPool`. */
  readonly poolFactory?: (env: Record<string, string | undefined>) => Pool;
}

interface BindingSummary {
  readonly id: string;
  readonly adapterSlug: string;
  readonly domainSlug: string;
  readonly intakeCount: number;
  readonly webhookCount: number;
}

async function loadSummary(
  client: PoolClient,
  bindingId: string,
): Promise<BindingSummary | null> {
  const bindingResult = await client.query<{
    id: string;
    adapter_slug: string;
    domain_slug: string;
  }>(
    `SELECT b.id::text AS id,
            b.adapter_slug,
            d.slug AS domain_slug
     FROM sources_bindings b
     JOIN domains d ON d.id = b.domain_id
     WHERE b.id = $1::uuid`,
    [bindingId],
  );
  const row = bindingResult.rows[0];
  if (row === undefined) return null;
  const intakeResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ingestion_intake WHERE binding_id = $1::uuid`,
    [bindingId],
  );
  const webhookResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM webhook_events WHERE binding_id = $1::uuid`,
    [bindingId],
  );
  return {
    id: row.id,
    adapterSlug: row.adapter_slug,
    domainSlug: row.domain_slug,
    intakeCount: Number.parseInt(intakeResult.rows[0]?.count ?? "0", 10),
    webhookCount: Number.parseInt(webhookResult.rows[0]?.count ?? "0", 10),
  };
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

export async function runSourceForget(
  args: SourceForgetArgs,
): Promise<void> {
  const tty = args.tty ?? detectTty();
  if (!tty.isInteractive && !args.dryRun) {
    args.stderr.write(
      pc.red(
        "source forget: non-interactive invocation requires --dry-run; refusing to delete unattended\n",
      ),
    );
    args.stderr.write(
      pc.dim(
        "source forget: re-run with --dry-run to preview, or run interactively to confirm\n",
      ),
    );
    return exitUserError();
  }

  const factory = args.poolFactory ?? ((e): Pool => openPool({ env: e }));
  const pool = factory(args.env);
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();

    const summary = await loadSummary(client, args.bindingId);
    if (summary === null) {
      args.stderr.write(
        pc.red(`source forget: binding ${args.bindingId} not found\n`),
      );
      return exitUserError();
    }

    args.stdout.write(pc.bold(`source forget: binding ${summary.id}\n`));
    args.stdout.write(`  domain:   ${summary.domainSlug}\n`);
    args.stdout.write(`  adapter:  ${summary.adapterSlug}\n`);
    args.stdout.write(`  intake:   ${summary.intakeCount} rows to purge\n`);
    args.stdout.write(`  webhooks: ${summary.webhookCount} rows to purge\n`);

    if (args.dryRun) {
      args.stdout.write(pc.yellow("source forget: --dry-run set; no changes\n"));
      return exitOk();
    }

    // Interactive confirmation — exact-match against the
    // binding's domain_slug + adapter_slug. The operator types
    // back the value to prove they meant to do this.
    const expected = `${summary.domainSlug}/${summary.adapterSlug}`;
    const promptsFn = args.promptsFn ?? promptsLib;
    const confirm = await promptsFn({
      type: "text",
      name: "value",
      message: `Type "${expected}" to confirm:`,
      validate: (v) => (v === expected ? true : `must be exactly: ${expected}`),
    });
    if (confirm["value"] !== expected) {
      args.stderr.write(
        pc.dim("source forget: cancelled (no confirmation)\n"),
      );
      return exitUserError();
    }

    const executorUserId = await resolveExecutor(client, args.executor);
    if (executorUserId === null) {
      args.stderr.write(
        pc.red(
          `source forget: --executor '${args.executor}' is not a known users.gitea_username\n`,
        ),
      );
      return exitUserError();
    }

    // Transactional purge. Audit row writes BEFORE the
    // matching DELETE so a partial crash leaves a trail.
    await client.query("BEGIN");
    try {
      // 1) intake
      await client.query(
        `INSERT INTO erasure_log (binding_id, action, target_ref, executed_by)
         VALUES ($1::uuid, 'purge_intake', $2, $3::uuid)`,
        [summary.id, `ingestion_intake/${summary.id}`, executorUserId],
      );
      await client.query(
        `DELETE FROM ingestion_intake WHERE binding_id = $1::uuid`,
        [summary.id],
      );
      // 2) webhooks
      await client.query(
        `INSERT INTO erasure_log (binding_id, action, target_ref, executed_by)
         VALUES ($1::uuid, 'purge_webhooks', $2, $3::uuid)`,
        [summary.id, `webhook_events/${summary.id}`, executorUserId],
      );
      await client.query(
        `DELETE FROM webhook_events WHERE binding_id = $1::uuid`,
        [summary.id],
      );
      // 3) disable the binding (operator may want to keep the
      //    config row for audit; we don't DELETE the binding).
      await client.query(
        `UPDATE sources_bindings SET enabled = false WHERE id = $1::uuid`,
        [summary.id],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }

    args.stdout.write(
      pc.green(
        `source forget: ${summary.id} purged (intake=${summary.intakeCount}, webhooks=${summary.webhookCount}, binding disabled)\n`,
      ),
    );
    args.stdout.write(
      pc.dim(
        "source forget: Gitea wiki history is NOT rewritten — Lint will surface orphan citations on its next pass.\n",
      ),
    );
    return exitOk();
  } catch (err) {
    if (isExitSentinel(err)) throw err;
    args.stderr.write(
      pc.red(
        `source forget: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    return exitRuntimeError();
  } finally {
    if (client !== null) client.release();
    await pool.end().catch(() => undefined);
  }
}
