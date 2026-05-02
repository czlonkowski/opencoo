/**
 * SSE heartbeat ping — verifies the 15 s ping fires (phase-a appendix #4
 * PR-B, fix I3/I4).
 *
 * Why a real `app.listen()` and not `app.inject()`:
 *   Fastify's `inject()` reads the COMPLETE response body before
 *   returning. The SSE route parks the Fastify reply (never calls
 *   `reply.send()`) to keep the TCP socket open, so `inject()` would
 *   block forever once the heartbeat path is active.
 *
 * Heartbeat test strategy:
 *   Rather than advancing fake timers over a live HTTP stream (which
 *   causes vitest to hit its 10 000-timer runaway guard because
 *   `setInterval` keeps re-queuing itself), we test the heartbeat
 *   mechanism via a real `app.listen()` server and a small delay:
 *   the SSE route receives a `setIntervalFn` seam that calls the
 *   callback immediately (after 0 ms), so the ping appears in the
 *   stream without waiting 15 real seconds. The AbortController then
 *   cleanly tears down the connection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";

import * as schema from "@opencoo/shared/db/schema";
import { InMemoryCredentialStore } from "@opencoo/shared/credential-store";
import { ConsoleLogger } from "@opencoo/shared/logger";

import { registerAdminApi } from "../../src/admin-api/index.js";
import { __resetAdminAuthCache } from "../../src/admin-api/auth.js";
import { MockGiteaClient } from "./_fixture.js";

const ADMIN_PAT = "sse-heartbeat-pat";

// ── Build DDL for the in-memory DB ─────────────────────────────────────────

function buildEnumsDdl(): string {
  const lines: string[] = [];
  for (const value of Object.values(schema)) {
    if (isPgEnum(value)) {
      const e = value as PgEnum<[string, ...string[]]>;
      const literals = e.enumValues
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ");
      lines.push(`CREATE TYPE "${e.enumName}" AS ENUM (${literals});`);
    }
  }
  return lines.join("\n");
}

const MINIMAL_TABLES_DDL = `
  CREATE TABLE domains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    class domain_class DEFAULT 'knowledge' NOT NULL,
    locale text DEFAULT 'en' NOT NULL,
    governance_cadence governance_cadence DEFAULT 'continuous' NOT NULL,
    review_role text,
    llm_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    llm_budget_monthly_cap_usd numeric(10, 2),
    retention_days integer,
    worldview_enabled boolean DEFAULT true NOT NULL,
    is_aggregator boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    gitea_username text NOT NULL UNIQUE,
    role user_role DEFAULT 'operator' NOT NULL,
    gitea_teams jsonb DEFAULT '[]'::jsonb NOT NULL,
    gitea_teams_refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE admin_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    action text NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
    metadata jsonb NOT NULL,
    source_ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    definition_slug text NOT NULL,
    instance_id uuid,
    trigger agent_trigger NOT NULL,
    inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    output jsonb,
    skills_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    cost_usd numeric(10, 6) DEFAULT '0' NOT NULL,
    latency_ms integer DEFAULT 0 NOT NULL,
    status agent_run_status NOT NULL,
    error_class error_class,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE sources_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
    adapter_slug text NOT NULL,
    source_id text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    allowed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    review_mode review_mode DEFAULT 'auto' NOT NULL,
    schedule_cron text,
    credentials_id uuid,
    webhook_secret_credentials_id uuid,
    retention_days_override integer,
    enabled boolean DEFAULT true NOT NULL,
    last_scanned_at timestamp with time zone,
    last_scan_cursor text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE automation_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    surfacer_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
    source_page_refs jsonb NOT NULL,
    proposal jsonb NOT NULL,
    status automation_candidate_status NOT NULL DEFAULT 'proposed',
    rationale text,
    reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE marketplace_updates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    marketplace_source text NOT NULL,
    release_tag text NOT NULL,
    target_commitish text NOT NULL,
    tree_sha text NOT NULL,
    skills_diff jsonb NOT NULL,
    status marketplace_update_status NOT NULL DEFAULT 'pending',
    reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketplace_updates_source_release_tag_unique UNIQUE (marketplace_source, release_tag)
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    event_id text,
    payload_hash text NOT NULL,
    payload jsonb,
    signature_ok boolean NOT NULL,
    binding_id uuid REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    delivery_count integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'pending',
    received_at timestamp with time zone NOT NULL DEFAULT now(),
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ingestion_intake (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL REFERENCES sources_bindings(id) ON DELETE RESTRICT,
    source_doc_id text NOT NULL,
    source_revision text NOT NULL,
    content_hash text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    last_classifier_run_id text,
    error_class text,
    error_text text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );
`;

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

// ── Fixture: real TCP server on random port ─────────────────────────────────
// The setIntervalFn seam is injected at server creation time so the heartbeat
// fires after a short real delay (1 ms) rather than 15 s or fake timers.
// This avoids the vitest timer runaway problem while still exercising the
// production heartbeat code path end-to-end over a real TCP socket.

let app: FastifyInstance;
let baseUrl: string;
let gitea: MockGiteaClient;
let pg: PGlite;

beforeAll(async () => {
  __resetAdminAuthCache();

  pg = new PGlite();
  await pg.exec(buildEnumsDdl());
  await pg.exec(MINIMAL_TABLES_DDL);
  const db = drizzle(pg, { schema });

  gitea = new MockGiteaClient();
  gitea.responses.set(ADMIN_PAT, {
    username: "alice",
    teams: ["opencoo-admins"],
  });

  const credentialStore = new InMemoryCredentialStore({ logger: silentLogger() });

  app = Fastify({ logger: false });

  // Inject a setIntervalFn that fires after 1 ms instead of 15 000 ms.
  // The clearIntervalFn delegates to the real clearTimeout (since the seam
  // uses setTimeout under the hood for the 1-shot test ping).
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  await registerAdminApi({
    app,
    db: db as unknown as Parameters<typeof registerAdminApi>[0]["db"],
    giteaClient: gitea,
    adminTeamSlug: "opencoo-admins",
    sessionHmacKey: Buffer.from("test-session-hmac-key-32-bytes-x"),
    logger: silentLogger(),
    llmDebugLog: false,
    provisionOrg: "opencoo",
    credentialStore,
    // Seam: replace setInterval(fn, 15000) with setTimeout(fn, 1) so the
    // ping arrives almost immediately in the test stream.
    sseSetIntervalFn: (fn: () => void) => {
      const id = setTimeout(() => { fn(); }, 1);
      pendingTimers.add(id);
      // Return the id cast to the setInterval return type — clearInterval
      // delegates to clearTimeout on the same id.
      return id as unknown as ReturnType<typeof setInterval>;
    },
    sseClearIntervalFn: (id: ReturnType<typeof setInterval>) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      pendingTimers.delete(id as unknown as ReturnType<typeof setTimeout>);
    },
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = address;
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SSE heartbeat — ping fires via setIntervalFn seam (real TCP, no fake timers)", () => {
  it("sends event: ping (heartbeat fires via 1 ms seam, not 15 s real timer)", async () => {
    // The setIntervalFn seam was injected at server startup (beforeAll) with a
    // 1 ms delay. When the client connects, the heartbeat fires after ~1 ms
    // instead of 15 000 ms — same code path, accelerated timing.
    const ac = new AbortController();
    const chunks: string[] = [];

    // Read events until we see a ping or the stream ends.
    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, 500); // safety timeout so test doesn't hang
    });

    const fetchPromise = fetch(`${baseUrl}/api/admin/events`, {
      headers: { authorization: `Bearer ${ADMIN_PAT}` },
      signal: ac.signal,
    }).then(async (res) => {
      const reader = res.body?.getReader();
      if (reader === undefined || reader === null) return;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value));
          // Stop once we see a ping — no need to read further.
          if (/event:\s*ping/.test(chunks.join(""))) break;
        }
      } catch {
        // AbortError on ac.abort() — expected.
      }
    });

    // Wait for either a ping to appear or the deadline.
    await Promise.race([
      fetchPromise,
      deadline,
    ]);

    ac.abort();
    await fetchPromise.catch(() => undefined);

    const body = chunks.join("");
    expect(body).toMatch(/event:\s*connected/);
    expect(body).toMatch(/event:\s*ping/);
  }, 2000 /* 2 s timeout — real TCP, no fake timers */);

  it("feed renders lifecycle events for ALL statuses (not just running)", async () => {
    // I5: The spec said UI subscribes only when run.status='running' but
    // operators want to see completions too. The Activity feed shows
    // agent_run events for all statuses (running, success, failed).
    // This test verifies the bus emits a 'success' status event and it
    // can be subscribed to normally.
    //
    // Note: This test is at the bus contract level; see streamed-tokens.test.ts
    // for the full bus emission tests. The Activity.tsx FeedView renders
    // every agent_run event regardless of status — that is the intended
    // behavior. A status filter is not needed because operators want to
    // see completions in the feed.
    //
    // This test simply verifies the bus emits events with status='success'
    // and subscribers receive them (the 'only running' spec was relaxed).
    const { createSseBus } = await import("../../src/admin-api/sse-bus.js");
    const bus = createSseBus();
    const received: string[] = [];
    bus.onRunEvent((e) => received.push(e.status));

    bus.emitRunEvent({
      runId: "r1",
      definitionSlug: "heartbeat",
      status: "success",
      startedAt: new Date().toISOString(),
    });

    expect(received).toContain("success");
  });
});
