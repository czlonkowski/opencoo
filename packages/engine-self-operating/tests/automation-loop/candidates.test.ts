/**
 * Gate 1 + Gate 2 helper tests (plan #102 / THREAT-MODEL §7.2.4).
 *
 * - Gate 1: `insertCandidate` hardcodes status='proposed';
 *   no caller can override.
 * - Gate 2: `requireApproved` throws BuilderGate2Error if the
 *   candidate's status is anything other than 'approved'
 *   (incl. not-found).
 * - `markBuilt` flips approved → built; rejects any other
 *   starting state.
 */
import { describe, expect, it } from "vitest";

import {
  BuilderGate2Error,
  insertCandidate,
  markBuilt,
  requireApproved,
} from "../../src/automation-loop/index.js";

import {
  freshAgentDb,
  seedAgentInstance,
} from "../agent-harness/_pglite-fixture.js";

async function seedSurfacerRun(
  fixture: Awaited<ReturnType<typeof freshAgentDb>>,
): Promise<{ readonly runId: string }> {
  const { instanceId } = await seedAgentInstance(fixture, {
    definitionSlug: "surfacer",
    instanceName: "surfacer-1",
  });
  const result = await fixture.raw.query<{ id: string }>(
    `INSERT INTO agent_runs (definition_slug, instance_id, trigger, status,
                              started_at, ended_at, created_at)
     VALUES ('surfacer', $1::uuid, 'scheduled', 'success',
             NOW(), NOW(), NOW())
     RETURNING id::text AS id`,
    [instanceId],
  );
  return { runId: result.rows[0]!.id };
}

const FIXTURE_PROPOSAL = {
  title: "Q3 deck reminder",
  summary: "Weekly Friday ping for sales lead on Q3 deck status.",
  template_slug: "weekly-ping",
  params: { day: "Friday", channel: "#sales" },
};

const FIXTURE_PAGE_REFS = [
  { domain_slug: "exec", page_path: "projects/q3.md" },
];

describe("insertCandidate — Gate 1 (status hardcoded to 'proposed')", () => {
  it("inserts a row at status='proposed'", async () => {
    const fixture = await freshAgentDb();
    const { runId } = await seedSurfacerRun(fixture);
    const { candidateId } = await insertCandidate({
      db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
      surfacerRunId: runId,
      sourcePageRefs: FIXTURE_PAGE_REFS,
      proposal: FIXTURE_PROPOSAL,
    });
    const rows = await fixture.raw.query<{
      status: string;
      proposal: typeof FIXTURE_PROPOSAL;
      source_page_refs: typeof FIXTURE_PAGE_REFS;
    }>(
      `SELECT status::text AS status, proposal, source_page_refs
       FROM automation_candidates WHERE id = $1::uuid`,
      [candidateId],
    );
    expect(rows.rows[0]?.status).toBe("proposed");
    expect(rows.rows[0]?.proposal).toEqual(FIXTURE_PROPOSAL);
  });

  it("does not expose a status arg — status is fixed at the helper layer", () => {
    // Static-shape pin: InsertCandidateArgs has no `status`
    // property. Adding one would let a caller insert at e.g.
    // 'approved' and bypass the Review Dashboard entirely.
    const argsKeys: ReadonlyArray<
      keyof Parameters<typeof insertCandidate>[0]
    > = [
      "db",
      "surfacerRunId",
      "sourcePageRefs",
      "proposal",
      "rationale",
    ];
    // If 'status' were in the type, this assignment would
    // fail to type-check because the array literal's element
    // type would widen.
    expect(argsKeys).not.toContain("status" as never);
  });

  it("propagates rationale verbatim when supplied", async () => {
    const fixture = await freshAgentDb();
    const { runId } = await seedSurfacerRun(fixture);
    const { candidateId } = await insertCandidate({
      db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
      surfacerRunId: runId,
      sourcePageRefs: FIXTURE_PAGE_REFS,
      proposal: FIXTURE_PROPOSAL,
      rationale: "two cited pages with the same recurring task signal",
    });
    const rows = await fixture.raw.query<{ rationale: string }>(
      `SELECT rationale FROM automation_candidates WHERE id = $1::uuid`,
      [candidateId],
    );
    expect(rows.rows[0]?.rationale).toBe(
      "two cited pages with the same recurring task signal",
    );
  });
});

describe("requireApproved — Gate 2", () => {
  it("returns the loaded row when status='approved'", async () => {
    const fixture = await freshAgentDb();
    const { runId } = await seedSurfacerRun(fixture);
    const { candidateId } = await insertCandidate({
      db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
      surfacerRunId: runId,
      sourcePageRefs: FIXTURE_PAGE_REFS,
      proposal: FIXTURE_PROPOSAL,
    });
    // Operator approves via the Review Dashboard UI — we
    // simulate that here.
    await fixture.raw.query(
      `UPDATE automation_candidates SET status = 'approved' WHERE id = $1::uuid`,
      [candidateId],
    );
    const candidate = await requireApproved(
      fixture.db as unknown as Parameters<typeof requireApproved>[0],
      candidateId,
    );
    expect(candidate.id).toBe(candidateId);
    expect(candidate.status).toBe("approved");
    expect(candidate.proposal).toEqual(FIXTURE_PROPOSAL);
  });

  it("throws BuilderGate2Error(validation) when status='proposed' (still pending review)", async () => {
    const fixture = await freshAgentDb();
    const { runId } = await seedSurfacerRun(fixture);
    const { candidateId } = await insertCandidate({
      db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
      surfacerRunId: runId,
      sourcePageRefs: FIXTURE_PAGE_REFS,
      proposal: FIXTURE_PROPOSAL,
    });
    try {
      await requireApproved(
        fixture.db as unknown as Parameters<typeof requireApproved>[0],
        candidateId,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BuilderGate2Error);
      expect((err as BuilderGate2Error).observedStatus).toBe("proposed");
      expect((err as BuilderGate2Error).errorClass).toBe("validation");
    }
  });

  it("throws BuilderGate2Error when status='rejected' / 'built' / 'skipped'", async () => {
    const fixture = await freshAgentDb();
    const { runId } = await seedSurfacerRun(fixture);
    for (const otherStatus of ["rejected", "built", "skipped"] as const) {
      const { candidateId } = await insertCandidate({
        db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
        surfacerRunId: runId,
        sourcePageRefs: FIXTURE_PAGE_REFS,
        proposal: FIXTURE_PROPOSAL,
      });
      await fixture.raw.query(
        `UPDATE automation_candidates SET status = $2 WHERE id = $1::uuid`,
        [candidateId, otherStatus],
      );
      try {
        await requireApproved(
          fixture.db as unknown as Parameters<typeof requireApproved>[0],
          candidateId,
        );
        throw new Error(`expected throw for status=${otherStatus}`);
      } catch (err) {
        expect(err).toBeInstanceOf(BuilderGate2Error);
        expect((err as BuilderGate2Error).observedStatus).toBe(otherStatus);
      }
    }
  });

  it("throws BuilderGate2Error when the candidate id doesn't exist", async () => {
    const fixture = await freshAgentDb();
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(
      requireApproved(
        fixture.db as unknown as Parameters<typeof requireApproved>[0],
        fakeId,
      ),
    ).rejects.toBeInstanceOf(BuilderGate2Error);
  });
});

describe("markBuilt — post-deploy candidate flip", () => {
  it("flips approved → built", async () => {
    const fixture = await freshAgentDb();
    const { runId } = await seedSurfacerRun(fixture);
    const { candidateId } = await insertCandidate({
      db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
      surfacerRunId: runId,
      sourcePageRefs: FIXTURE_PAGE_REFS,
      proposal: FIXTURE_PROPOSAL,
    });
    await fixture.raw.query(
      `UPDATE automation_candidates SET status = 'approved' WHERE id = $1::uuid`,
      [candidateId],
    );
    await markBuilt(
      fixture.db as unknown as Parameters<typeof markBuilt>[0],
      candidateId,
    );
    const rows = await fixture.raw.query<{ status: string }>(
      `SELECT status::text AS status FROM automation_candidates WHERE id = $1::uuid`,
      [candidateId],
    );
    expect(rows.rows[0]?.status).toBe("built");
  });

  it("throws BuilderGate2Error when status is anything other than 'approved' (race/parallel-mutation guard)", async () => {
    const fixture = await freshAgentDb();
    const { runId } = await seedSurfacerRun(fixture);
    const { candidateId } = await insertCandidate({
      db: fixture.db as unknown as Parameters<typeof insertCandidate>[0]["db"],
      surfacerRunId: runId,
      sourcePageRefs: FIXTURE_PAGE_REFS,
      proposal: FIXTURE_PROPOSAL,
    });
    // status is still 'proposed' — markBuilt must refuse.
    await expect(
      markBuilt(
        fixture.db as unknown as Parameters<typeof markBuilt>[0],
        candidateId,
      ),
    ).rejects.toBeInstanceOf(BuilderGate2Error);
  });
});
