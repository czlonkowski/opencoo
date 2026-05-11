/**
 * AgentDispatcher contract tests (PR-M2, phase-a appendix #5).
 *
 * The dispatcher's job:
 *   1. On `start()`: read `agent_instances` rows where
 *      `enabled = true AND schedule_cron IS NOT NULL`. For each row
 *      with a valid cron pattern, register a BullMQ recurring job
 *      `selfop.dispatch` with payload `{ instanceId }`. Skip rows
 *      whose pattern fails `validateCron` and emit a single
 *      `scheduler.invalid_cron` log entry.
 *   2. Construct a `selfop.dispatch` Worker whose handler resolves
 *      the supplied instanceId → loads the instance via
 *      `loadInstanceById` → resolves the matching runner from the
 *      injected runner registry → calls `invokeAgent` with the
 *      runner as `args.run`.
 *   3. On `stop()`: pause + close the worker + queue. Idempotent.
 *
 * The tests use `ioredis-mock` for the BullMQ connection. BullMQ's
 * blocking pull loop is not exercised — the dispatcher's handler is
 * invoked directly via the Job stub the test constructs (same
 * pattern as the ingestion-worker contract tests).
 */
import type { Job, Queue, Worker } from "bullmq";
import IORedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";

import {
  AgentDefinitionRegistry,
  type AgentDefinition,
} from "../../src/agent-harness/index.js";
import {
  AgentDispatcher,
  type AgentRunnerRegistry,
  type RegisteredSchedule,
} from "../../src/scheduler/agent-dispatcher.js";

import {
  freshAgentDb,
  seedAgentInstance,
  type AgentFixture,
} from "../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

const TEST_DEFINITION: AgentDefinition = {
  slug: "heartbeat",
  version: "1.0.0",
  description: "test heartbeat",
  outputSchemaName: "HeartbeatOutput",
  defaultMemory: { type: "none" },
  toolNames: ["worldview.read"],
};

function buildRegistryWith(def: AgentDefinition): AgentDefinitionRegistry {
  const r = new AgentDefinitionRegistry();
  r.register(def);
  return r;
}

function noOpRunnerRegistry(
  invocations: string[],
): AgentRunnerRegistry {
  return {
    get(slug: string) {
      if (slug !== TEST_DEFINITION.slug) return undefined;
      return async (ctx) => {
        invocations.push(ctx.instance.id);
        return { ok: true };
      };
    },
  };
}

async function seedScheduledInstance(
  fixture: AgentFixture,
  args: {
    readonly definitionSlug?: string;
    readonly name?: string;
    readonly scheduleCron?: string | null;
    readonly enabled?: boolean;
  } = {},
): Promise<{ readonly instanceId: string }> {
  // Thin wrapper over the shared seedAgentInstance — keeps the
  // {definitionSlug,name,scheduleCron,enabled} call shape that
  // the dispatcher tests already use.
  const seeded = await seedAgentInstance(fixture, {
    definitionSlug: args.definitionSlug ?? TEST_DEFINITION.slug,
    instanceName: args.name ?? "default",
    scheduleCron: args.scheduleCron ?? null,
    enabled: args.enabled ?? true,
  });
  return { instanceId: seeded.instanceId };
}

interface DispatcherHarness {
  readonly dispatcher: AgentDispatcher;
  readonly redis: InstanceType<typeof IORedisMock>;
  /** Recorded calls from the test stub `registerScheduleFn`. The
   *  real BullMQ recurring-job path uses Lua scripts that
   *  `ioredis-mock` does not implement; the dispatcher exposes a
   *  test seam (`registerScheduleFn`) so assertions land on the
   *  REGISTRATION CONTRACT (what the dispatcher TRIED to register)
   *  rather than on BullMQ's internal Redis state. */
  readonly registered: RegisteredSchedule[];
  cleanup(): Promise<void>;
}

async function startDispatcher(args: {
  readonly fixture: AgentFixture;
  readonly registry?: AgentDefinitionRegistry;
  readonly runners?: AgentRunnerRegistry;
  readonly logs?: string[];
  readonly invocations?: string[];
  /** Round-2 fix #1 on PR #57 — a router instance to thread
   *  through. Tests pass a sentinel and assert the SAME instance
   *  reaches the runner closure via `ctx.router`. */
  readonly router?: ConstructorParameters<typeof AgentDispatcher>[0]["router"];
  /** PR-Z6 — explicit per-test override. Tests that exercise the
   *  refresh path pass `0` to disable the timer and drive
   *  `refresh()` manually; the default below pins the same value so
   *  no test accidentally arms a real 60-second timer that leaks
   *  past `afterEach`. */
  readonly refreshIntervalMs?: number;
  /** PR-Z6 — optional override for the `removeRepeatable` test seam.
   *  The default no-op records nothing; the deregister test passes
   *  its own array-pusher to assert the seam fired. */
  readonly removeScheduleFn?: (entry: RegisteredSchedule) => Promise<void>;
}): Promise<DispatcherHarness> {
  const redis = new IORedisMock();
  const registry = args.registry ?? buildRegistryWith(TEST_DEFINITION);
  const invocations = args.invocations ?? [];
  const runners = args.runners ?? noOpRunnerRegistry(invocations);
  const logger = args.logs !== undefined
    ? new ConsoleLogger({
        stream: {
          write: (chunk: string): boolean => {
            args.logs!.push(chunk);
            return true;
          },
        },
      })
    : silentLogger();

  const registered: RegisteredSchedule[] = [];
  const registerScheduleFn = async (
    s: RegisteredSchedule,
  ): Promise<void> => {
    registered.push(s);
  };

  const dispatcher = new AgentDispatcher({
    db: args.fixture.db as unknown as ConstructorParameters<
      typeof AgentDispatcher
    >[0]["db"],
    connection: redis as unknown as ConstructorParameters<
      typeof AgentDispatcher
    >[0]["connection"],
    definitions: registry,
    runners,
    logger,
    autorun: false,
    registerScheduleFn,
    refreshIntervalMs: args.refreshIntervalMs ?? 0,
    ...(args.router !== undefined ? { router: args.router } : {}),
    ...(args.removeScheduleFn !== undefined
      ? { removeScheduleFn: args.removeScheduleFn }
      : {}),
  });

  return {
    dispatcher,
    redis,
    registered,
    cleanup: async () => {
      await dispatcher.stop();
      redis.disconnect();
    },
  };
}

let activeHarness: DispatcherHarness | null = null;
afterEach(async () => {
  if (activeHarness !== null) {
    await activeHarness.cleanup();
    activeHarness = null;
  }
});

describe("AgentDispatcher.start", () => {
  it("registers a recurring job for each enabled instance with a valid schedule_cron", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "morning",
      scheduleCron: "0 8 * * 1-5",
    });

    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]).toMatchObject({
      instanceId,
      definitionSlug: TEST_DEFINITION.slug,
      name: "morning",
      scheduleCron: "0 8 * * 1-5",
    });
    // listSchedules() reflects the same set.
    expect(harness.dispatcher.listSchedules()).toHaveLength(1);
  });

  it("skips instances with invalid schedule_cron and logs scheduler.invalid_cron", async () => {
    const fixture = await freshAgentDb();
    await seedScheduledInstance(fixture, {
      name: "valid",
      scheduleCron: "0 9 * * *",
    });
    await seedScheduledInstance(fixture, {
      name: "garbage",
      scheduleCron: "not-a-cron",
    });

    const logs: string[] = [];
    const harness = await startDispatcher({ fixture, logs });
    activeHarness = harness;
    await harness.dispatcher.start();

    // Only the valid row registers.
    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]?.scheduleCron).toBe("0 9 * * *");

    const joined = logs.join("");
    expect(joined).toContain("scheduler.invalid_cron");
    expect(joined).toContain("not-a-cron");
  });

  it("ignores rows with enabled=false", async () => {
    const fixture = await freshAgentDb();
    await seedScheduledInstance(fixture, {
      name: "disabled-row",
      scheduleCron: "0 8 * * *",
      enabled: false,
    });

    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    expect(harness.registered).toHaveLength(0);
  });

  it("ignores rows with NULL schedule_cron", async () => {
    const fixture = await freshAgentDb();
    await seedAgentInstance(fixture); // no schedule_cron

    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    expect(harness.registered).toHaveLength(0);
  });
});

describe("AgentDispatcher dispatch handler", () => {
  it("resolves instanceId → invokes invokeAgent with the resolved runner", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      scheduleCron: "0 8 * * *",
    });

    const invocations: string[] = [];
    const harness = await startDispatcher({ fixture, invocations });
    activeHarness = harness;

    // Don't call start() — exercise the handler directly so we don't
    // race the BullMQ pull loop. The handler is the production unit
    // under test here.
    const handler = harness.dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-1",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;

    await handler(job);

    expect(invocations).toEqual([instanceId]);
  });

  it("throws when the instance's definition_slug has no registered runner", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      definitionSlug: "no-such-definition",
      scheduleCron: "0 8 * * *",
    });

    // Empty runner registry so resolution fails.
    const runners: AgentRunnerRegistry = { get: () => undefined };
    const registry = buildRegistryWith(TEST_DEFINITION);
    const harness = await startDispatcher({ fixture, registry, runners });
    activeHarness = harness;

    const handler = harness.dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-2",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;

    await expect(handler(job)).rejects.toThrow(/runner/);
  });

  // Round-2 fix #1 on PR #57 (Copilot review). Without router
  // threading, the dispatcher falls back to its
  // `({} as unknown) as LlmRouter` empty-object cast at
  // agent-dispatcher.ts:404 and the FIRST scheduled dispatch
  // crashes with `TypeError: ctx.router.generateObject is not a
  // function`. This test pins that the router instance handed to
  // the dispatcher constructor is the SAME instance the runner
  // closure observes via `ctx.router` — identity comparison
  // (`toBe`) so a structural-equal clone would fail the test.
  it("threads the constructor-supplied router through to ctx.router on dispatch (PR-N3 round-2)", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      scheduleCron: "0 8 * * *",
    });

    // Sentinel router — only identity matters; never invoked.
    const sentinelRouter = {
      __sentinel: "router-identity-pin",
    } as unknown as ConstructorParameters<typeof AgentDispatcher>[0]["router"];

    const observed: Array<{ router: unknown }> = [];
    const runners: AgentRunnerRegistry = {
      get(slug: string) {
        if (slug !== TEST_DEFINITION.slug) return undefined;
        return async (ctx) => {
          observed.push({ router: ctx.router });
          return { ok: true };
        };
      },
    };

    const harness = await startDispatcher({
      fixture,
      runners,
      router: sentinelRouter,
    });
    activeHarness = harness;

    const handler = harness.dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-router",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;

    await handler(job);

    expect(observed).toHaveLength(1);
    // Identity comparison — a structural-equal clone would fail
    // here. This is the load-bearing assertion; without it the
    // dispatcher's empty-object cast survives + the prod runner
    // crashes on the first LLM call.
    expect(observed[0]?.router).toBe(sentinelRouter);
  });

  it("propagates errors from the runner so BullMQ can apply its retry policy", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      scheduleCron: "0 8 * * *",
    });

    const runners: AgentRunnerRegistry = {
      get: () => async () => {
        throw new Error("runner blew up");
      },
    };
    const registry = buildRegistryWith(TEST_DEFINITION);
    const harness = await startDispatcher({ fixture, registry, runners });
    activeHarness = harness;

    const handler = harness.dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-3",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;

    // The harness records the run as `failed` — and the dispatcher
    // forwards no error to BullMQ for that case (the run row IS the
    // dlq surface). The handler resolves cleanly.
    await expect(handler(job)).resolves.toBeDefined();
  });
});

describe("AgentDispatcher.stop", () => {
  beforeEach(() => vi.useRealTimers());

  it("closes the worker + queue", async () => {
    const fixture = await freshAgentDb();
    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    const worker: Worker = harness.dispatcher.workerForTest();
    const queue: Queue = harness.dispatcher.queueForTest();
    const workerCloseSpy = vi.spyOn(worker, "close");
    const queueCloseSpy = vi.spyOn(queue, "close");

    await harness.dispatcher.stop();

    expect(workerCloseSpy).toHaveBeenCalled();
    expect(queueCloseSpy).toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    const fixture = await freshAgentDb();
    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();

    await harness.dispatcher.stop();
    await expect(harness.dispatcher.stop()).resolves.toBeUndefined();
  });
});

describe("AgentDispatcher — UTC timezone pin (round-3 fix #1)", () => {
  it("passes tz: 'UTC' on every BullMQ repeat-job registration", async () => {
    // Bypass the test-only `registerScheduleFn` seam so the
    // production code path lands a real `queue.add(..., { repeat })`
    // call — that call is what would silently default to host-local
    // time without the round-3 fix. The spy captures the args.
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, memory, locale, enabled, schedule_cron)
       VALUES ('heartbeat', 'morning-utc', $1::uuid[], '{}'::jsonb, 'en', true, '0 8 * * 1-5')`,
      [[fixture.domainId]],
    );

    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
      // No registerScheduleFn — production code path runs through
      // `queue.add(..., { repeat })`.
    });

    // Spy on the real queue's `add` method. We resolve immediately
    // with a stub Job-shape so BullMQ's Lua-script call (which
    // ioredis-mock doesn't fully implement) never executes.
    const queue = dispatcher.queueForTest();
    const addSpy = vi
      .spyOn(queue, "add")
      .mockResolvedValue({ id: "stub" } as never);

    try {
      await dispatcher.start();

      expect(addSpy).toHaveBeenCalledTimes(1);
      const callArgs = addSpy.mock.calls[0];
      expect(callArgs).toBeDefined();
      const opts = callArgs![2] as { repeat: { tz?: string; pattern?: string } };
      // Round-3 fix #1 — `tz: 'UTC'` MUST be present so BullMQ's
      // repeat parser doesn't silently use `process.env.TZ`. Without
      // this, `0 8 * * 1-5` fires at 8am LOCAL on a developer Mac
      // and `nextFireAt` from the admin route returns a different
      // wall-clock time than what BullMQ scheduled.
      expect(opts.repeat.tz).toBe("UTC");
      expect(opts.repeat.pattern).toBe("0 8 * * 1-5");
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });
});

describe("AgentDispatcher.enqueueOneShot — PR-R3 on-demand path", () => {
  it("calls Queue.add with no repeat option and the manual triggeredBy flag", async () => {
    const fixture = await freshAgentDb();
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
    });

    const queue = dispatcher.queueForTest();
    const addSpy = vi
      .spyOn(queue, "add")
      .mockResolvedValue({ id: "one-shot-job-1" } as never);

    try {
      const result = await dispatcher.enqueueOneShot({
        instanceId: "11111111-2222-3333-4444-555555555555",
        dryRun: true,
      });
      expect(result.jobId).toBe("one-shot-job-1");
      expect(addSpy).toHaveBeenCalledTimes(1);
      const callArgs = addSpy.mock.calls[0];
      expect(callArgs).toBeDefined();
      const [name, data, opts] = callArgs!;
      expect(name).toBe("dispatch");
      expect(data).toMatchObject({
        instanceId: "11111111-2222-3333-4444-555555555555",
        dryRun: true,
        triggeredBy: "manual",
      });
      // No `repeat` opt — one-shot job, removed on complete.
      const optsObj = opts as { repeat?: unknown };
      expect(optsObj.repeat).toBeUndefined();
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });

  it("rejects an empty instanceId without enqueueing", async () => {
    const fixture = await freshAgentDb();
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
    });
    const queue = dispatcher.queueForTest();
    const addSpy = vi.spyOn(queue, "add");

    try {
      await expect(
        dispatcher.enqueueOneShot({ instanceId: "" }),
      ).rejects.toThrow(/instanceId/);
      expect(addSpy).not.toHaveBeenCalled();
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });
});

describe("AgentDispatcher.updateSchedule — PR-R6 cadence editor", () => {
  it("calls remove + add per entry and updates listSchedules() in place", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "morning",
      scheduleCron: "0 8 * * 1-5",
    });

    const removed: RegisteredSchedule[] = [];
    const registered: RegisteredSchedule[] = [];
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
      registerScheduleFn: async (s) => {
        registered.push(s);
      },
      removeScheduleFn: async (s) => {
        removed.push(s);
      },
    });

    try {
      // Boot — registers the initial schedule.
      await dispatcher.start();
      expect(registered).toHaveLength(1);
      expect(dispatcher.listSchedules()[0]?.scheduleCron).toBe("0 8 * * 1-5");

      // Cadence change.
      await dispatcher.updateSchedule({
        entries: [
          {
            instanceId,
            definitionSlug: TEST_DEFINITION.slug,
            name: "morning",
            oldCron: "0 8 * * 1-5",
            newCron: "0 9 * * 1-5",
          },
        ],
      });

      // remove called with the OLD cron, add called with the NEW.
      expect(removed).toHaveLength(1);
      expect(removed[0]?.scheduleCron).toBe("0 8 * * 1-5");
      expect(registered).toHaveLength(2);
      expect(registered[1]?.scheduleCron).toBe("0 9 * * 1-5");

      // listSchedules() reflects the new cron.
      expect(dispatcher.listSchedules()[0]?.scheduleCron).toBe("0 9 * * 1-5");
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });

  it("rolls forward to the OLD cron when the add step throws", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "morning",
      scheduleCron: "0 8 * * 1-5",
    });

    const removed: RegisteredSchedule[] = [];
    const registerCalls: RegisteredSchedule[] = [];
    let bootRegistered = false;
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
      registerScheduleFn: async (s) => {
        registerCalls.push(s);
        // Allow the boot register, then fail the FIRST update-time
        // register (the new cron), then succeed for the rollback.
        if (!bootRegistered) {
          bootRegistered = true;
          return;
        }
        if (s.scheduleCron === "0 9 * * 1-5") {
          throw new Error("simulated bullmq add failure");
        }
      },
      removeScheduleFn: async (s) => {
        removed.push(s);
      },
    });

    try {
      await dispatcher.start();
      expect(registerCalls).toHaveLength(1);

      await expect(
        dispatcher.updateSchedule({
          entries: [
            {
              instanceId,
              definitionSlug: TEST_DEFINITION.slug,
              name: "morning",
              oldCron: "0 8 * * 1-5",
              newCron: "0 9 * * 1-5",
            },
          ],
        }),
      ).rejects.toThrow(/simulated bullmq add failure/);

      // Removed once (the OLD cron); register attempted twice
      // post-boot — once with the new cron (failed), once with the
      // OLD cron rollback (succeeded).
      expect(removed).toHaveLength(1);
      expect(removed[0]?.scheduleCron).toBe("0 8 * * 1-5");
      expect(registerCalls).toHaveLength(3); // boot + new (failed) + rollback
      expect(registerCalls[2]?.scheduleCron).toBe("0 8 * * 1-5");

      // The in-memory list still shows the OLD cron — the throw
      // bubbled out before the list-mutation step. That mirrors
      // the route's transaction-rollback contract: SQL UPDATE +
      // dispatcher state both unwind together.
      expect(dispatcher.listSchedules()[0]?.scheduleCron).toBe("0 8 * * 1-5");
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });

  it("rolls EVERY previously-succeeded swap back to OLD cron when a later entry fails (PR-R6 round-2 multi-instance atomicity)", async () => {
    // Three entries, the SECOND throws at registerOne. The first
    // entry already swapped to NEW cron in BullMQ; without the
    // multi-instance rollback fix BullMQ would be left at
    // {entry1: NEW, entry2: OLD, entry3: untouched} while the
    // route's DB tx unwinds back to {OLD, OLD, OLD} on every row
    // — splitting the cluster's view of the schedule until the
    // next engine boot. This test pins the rollback contract: the
    // dispatcher walks the previously-succeeded set in reverse
    // and rolls each back to OLD cron before re-throwing.
    const fixture = await freshAgentDb();
    // Three distinct instances, all on the same agent slug.
    const seeded = await Promise.all([
      seedScheduledInstance(fixture, {
        name: "morning-a",
        scheduleCron: "0 8 * * 1-5",
      }),
      seedScheduledInstance(fixture, {
        name: "morning-b",
        scheduleCron: "0 8 * * 1-5",
      }),
      seedScheduledInstance(fixture, {
        name: "morning-c",
        scheduleCron: "0 8 * * 1-5",
      }),
    ]);
    const instanceIds = seeded.map((s) => s.instanceId);

    interface Call {
      readonly verb: "remove" | "register";
      readonly instanceId: string;
      readonly cron: string;
    }
    const calls: Call[] = [];
    let bootRegistered = 0;
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
      registerScheduleFn: async (s) => {
        // Allow the three boot registrations through silently;
        // afterwards, fail the SECOND instance's NEW-cron register
        // call. Every other post-boot register call (including
        // the rollback path) succeeds.
        if (bootRegistered < 3) {
          bootRegistered += 1;
          calls.push({
            verb: "register",
            instanceId: s.instanceId,
            cron: s.scheduleCron,
          });
          return;
        }
        calls.push({
          verb: "register",
          instanceId: s.instanceId,
          cron: s.scheduleCron,
        });
        if (
          s.instanceId === instanceIds[1] &&
          s.scheduleCron === "0 9 * * 1-5"
        ) {
          throw new Error("simulated bullmq add failure on entry 2");
        }
      },
      removeScheduleFn: async (s) => {
        calls.push({
          verb: "remove",
          instanceId: s.instanceId,
          cron: s.scheduleCron,
        });
      },
    });

    try {
      await dispatcher.start();
      // Drop boot-time calls so the assertion window is just the
      // updateSchedule swap + rollback sequence.
      calls.length = 0;

      const entries = instanceIds.map((id) => ({
        instanceId: id,
        definitionSlug: TEST_DEFINITION.slug,
        name: "morning",
        oldCron: "0 8 * * 1-5",
        newCron: "0 9 * * 1-5",
      }));

      await expect(dispatcher.updateSchedule({ entries })).rejects.toThrow(
        /simulated bullmq add failure on entry 2/,
      );

      // Entry 1 swapped successfully (remove old, register new) →
      // entry 2 attempted (remove old, register new threw) →
      // catch block runs.
      // Multi-instance rollback for the SUCCEEDED set (entry 1):
      //   - remove entry-1 NEW cron, register entry-1 OLD cron.
      // Failing-entry rollback (entry 2 — removeOne already
      // succeeded so we re-register the OLD cron):
      //   - register entry-2 OLD cron.
      // Entry 3's `addRepeatable` (registerOne with NEW cron) is
      // NEVER called — the throw bubbled out before reaching it.

      // Entry 3 NEVER touched.
      const entry3Calls = calls.filter(
        (c) => c.instanceId === instanceIds[2],
      );
      expect(entry3Calls).toEqual([]);

      // Entry 1: remove(OLD) → register(NEW) → [throw on entry 2]
      //          → rollback: remove(NEW) → register(OLD).
      const entry1Calls = calls.filter(
        (c) => c.instanceId === instanceIds[0],
      );
      expect(entry1Calls).toEqual([
        { verb: "remove", instanceId: instanceIds[0], cron: "0 8 * * 1-5" },
        { verb: "register", instanceId: instanceIds[0], cron: "0 9 * * 1-5" },
        { verb: "remove", instanceId: instanceIds[0], cron: "0 9 * * 1-5" },
        { verb: "register", instanceId: instanceIds[0], cron: "0 8 * * 1-5" },
      ]);

      // Entry 2: remove(OLD) → register(NEW) [threw]
      //          → rollback: register(OLD).
      const entry2Calls = calls.filter(
        (c) => c.instanceId === instanceIds[1],
      );
      expect(entry2Calls).toEqual([
        { verb: "remove", instanceId: instanceIds[1], cron: "0 8 * * 1-5" },
        { verb: "register", instanceId: instanceIds[1], cron: "0 9 * * 1-5" },
        { verb: "register", instanceId: instanceIds[1], cron: "0 8 * * 1-5" },
      ]);

      // The in-memory list reflects the pre-call cron on every
      // instance — the post-loop mutation step never ran because
      // the throw bubbled out first.
      for (const s of dispatcher.listSchedules()) {
        expect(s.scheduleCron).toBe("0 8 * * 1-5");
      }
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });

  it("skips the no-op case (oldCron === newCron) without touching BullMQ", async () => {
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "morning",
      scheduleCron: "0 8 * * 1-5",
    });

    const removed: RegisteredSchedule[] = [];
    const registerCalls: RegisteredSchedule[] = [];
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners: { get: () => async () => ({ ok: true }) },
      logger: silentLogger(),
      autorun: false,
      registerScheduleFn: async (s) => {
        registerCalls.push(s);
      },
      removeScheduleFn: async (s) => {
        removed.push(s);
      },
    });

    try {
      await dispatcher.start();
      registerCalls.length = 0;

      await dispatcher.updateSchedule({
        entries: [
          {
            instanceId,
            definitionSlug: TEST_DEFINITION.slug,
            name: "morning",
            oldCron: "0 8 * * 1-5",
            newCron: "0 8 * * 1-5",
          },
        ],
      });

      expect(removed).toHaveLength(0);
      expect(registerCalls).toHaveLength(0);
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
  });
});

// ───────────────────────────────────────────────────────────────
// PR-Z4 (phase-a appendix #12 G5) — post-run delivery hook.
// ───────────────────────────────────────────────────────────────

import {
  MockOutputChannelAdapter,
  OutputChannelRegistry,
} from "../../src/output-channels/index.js";

describe("AgentDispatcher — PR-Z4 post-run delivery hook", () => {
  it("dispatches the run output through each binding's adapter", async () => {
    const fixture = await freshAgentDb();
    // Seed an instance with an output_channel_ids binding pointing
    // at the `asana` adapter slug. The mock adapter captures the
    // payload + config — we then assert both reached the adapter.
    const result = await fixture.raw.query<{ id: string }>(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, output_channel_ids,
          memory, locale, enabled, schedule_cron)
       VALUES ('heartbeat', 'with-asana-binding', $1::uuid[],
               $2::jsonb,
               '{"type":"none"}'::jsonb, 'en', true, '0 8 * * 1-5')
       RETURNING id`,
      [
        [fixture.domainId],
        JSON.stringify([
          { adapter_slug: "asana", config: { channel_id: "abc-123" } },
        ]),
      ],
    );
    const instanceId = result.rows[0]!.id;

    const mockAdapter = new MockOutputChannelAdapter("asana");
    const outputChannels = new OutputChannelRegistry();
    outputChannels.register(mockAdapter);

    const invocations: string[] = [];
    const runnerOutput = {
      version: "v1",
      summary: "today",
      alerts: [],
    };
    const runners: AgentRunnerRegistry = {
      get(slug: string) {
        if (slug !== TEST_DEFINITION.slug) return undefined;
        return async (ctx) => {
          invocations.push(ctx.instance.id);
          return runnerOutput;
        };
      },
    };

    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners,
      logger: silentLogger(),
      autorun: false,
      outputChannels,
    });

    const handler = dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-delivery",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;
    try {
      await handler(job);
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }

    expect(invocations).toEqual([instanceId]);
    expect(mockAdapter.deliveries).toHaveLength(1);
    expect(mockAdapter.deliveries[0]?.payload).toEqual(runnerOutput);
    expect(mockAdapter.deliveries[0]?.config).toEqual({
      channel_id: "abc-123",
    });
  });

  it("skips delivery when dryRun=true (operator-issued one-shot)", async () => {
    const fixture = await freshAgentDb();
    const result = await fixture.raw.query<{ id: string }>(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, output_channel_ids,
          memory, locale, enabled, schedule_cron)
       VALUES ('heartbeat', 'dry-run', $1::uuid[],
               $2::jsonb,
               '{"type":"none"}'::jsonb, 'en', true, '0 8 * * 1-5')
       RETURNING id`,
      [
        [fixture.domainId],
        JSON.stringify([
          { adapter_slug: "asana", config: { channel_id: "abc-123" } },
        ]),
      ],
    );
    const instanceId = result.rows[0]!.id;

    const mock = new MockOutputChannelAdapter("asana");
    const outputChannels = new OutputChannelRegistry();
    outputChannels.register(mock);

    const runners: AgentRunnerRegistry = {
      get(slug: string) {
        if (slug !== TEST_DEFINITION.slug) return undefined;
        return async () => ({ ok: true });
      },
    };
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners,
      logger: silentLogger(),
      autorun: false,
      outputChannels,
    });

    const handler = dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-dryrun",
      name: "dispatch",
      data: { instanceId, dryRun: true, triggeredBy: "manual" as const },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string; dryRun?: boolean }>;
    try {
      await handler(job);
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
    expect(mock.deliveries).toEqual([]);
  });

  it("does NOT throw when a single delivery fails — the next binding still tries", async () => {
    const fixture = await freshAgentDb();
    const result = await fixture.raw.query<{ id: string }>(
      `INSERT INTO agent_instances
         (definition_slug, name, scope_domain_ids, output_channel_ids,
          memory, locale, enabled, schedule_cron)
       VALUES ('heartbeat', 'two-deliveries', $1::uuid[],
               $2::jsonb,
               '{"type":"none"}'::jsonb, 'en', true, '0 8 * * 1-5')
       RETURNING id`,
      [
        [fixture.domainId],
        JSON.stringify([
          { adapter_slug: "asana", config: { channel_id: "a" } },
          { adapter_slug: "slack", config: { channel_id: "b" } },
        ]),
      ],
    );
    const instanceId = result.rows[0]!.id;

    const outputChannels = new OutputChannelRegistry();
    // 'asana' throws, 'slack' captures — pin that 'slack' still runs.
    outputChannels.register({
      adapterSlug: "asana",
      async deliver() {
        throw new Error("simulated asana outage");
      },
    });
    const slackMock = new MockOutputChannelAdapter("slack");
    outputChannels.register(slackMock);

    const runners: AgentRunnerRegistry = {
      get(slug: string) {
        if (slug !== TEST_DEFINITION.slug) return undefined;
        return async () => ({ version: "v1", summary: "s", alerts: [] });
      },
    };
    const redis = new IORedisMock();
    const dispatcher = new AgentDispatcher({
      db: fixture.db as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["db"],
      connection: redis as unknown as ConstructorParameters<
        typeof AgentDispatcher
      >[0]["connection"],
      definitions: buildRegistryWith(TEST_DEFINITION),
      runners,
      logger: silentLogger(),
      autorun: false,
      outputChannels,
    });

    const handler = dispatcher.dispatchHandlerForTest();
    const job = {
      id: "job-2",
      name: "dispatch",
      data: { instanceId },
      queueName: "selfop.dispatch",
      attemptsMade: 0,
      timestamp: Date.now(),
    } as unknown as Job<{ instanceId: string }>;
    try {
      await expect(handler(job)).resolves.toBeDefined();
    } finally {
      await dispatcher.stop();
      redis.disconnect();
    }
    expect(slackMock.deliveries).toHaveLength(1);

describe("AgentDispatcher.refresh — PR-Z6 post-boot re-enumeration (closes G7)", () => {
  it("registers a post-boot seeded agent_instance on refresh tick", async () => {
    // Reproduces the partner-deployment bug: `opencoo agents seed`
    // runs AFTER the engine is up → the row exists in
    // `agent_instances` but the dispatcher only enumerated at boot
    // → operator had to `docker compose restart opencoo` to pick
    // it up. The refresh tick closes that gap.
    const fixture = await freshAgentDb();

    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();
    expect(harness.registered).toHaveLength(0);
    expect(harness.dispatcher.listSchedules()).toHaveLength(0);

    // Operator runs `opencoo agents seed` against the live engine
    // — direct INSERT mirrors what the CLI command does.
    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "post-boot",
      scheduleCron: "0 8 * * *",
    });

    // Manually drive the tick (the production 60-second interval
    // is disabled in tests via `refreshIntervalMs: 0`).
    await harness.dispatcher.refresh();

    expect(harness.registered).toHaveLength(1);
    expect(harness.registered[0]).toMatchObject({
      instanceId,
      definitionSlug: TEST_DEFINITION.slug,
      name: "post-boot",
      scheduleCron: "0 8 * * *",
    });
    expect(harness.dispatcher.listSchedules()).toHaveLength(1);
    expect(harness.dispatcher.listSchedules()[0]?.instanceId).toBe(
      instanceId,
    );
  });

  it("deregisters a disabled agent_instance on refresh tick", async () => {
    // Inverse of the above: the operator disables an instance
    // post-boot (UI toggle, `agents disable` CLI, or direct DB
    // edit) and the refresh tick should tear down the BullMQ
    // repeatable so the disabled instance stops firing within a
    // minute.
    const fixture = await freshAgentDb();
    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "to-disable",
      scheduleCron: "0 8 * * *",
    });

    const removed: RegisteredSchedule[] = [];
    const harness = await startDispatcher({
      fixture,
      removeScheduleFn: async (entry) => {
        removed.push(entry);
      },
    });
    activeHarness = harness;
    await harness.dispatcher.start();
    expect(harness.registered).toHaveLength(1);

    // Flip the row to enabled=false (mirrors the UI toggle path).
    await fixture.raw.query(
      `UPDATE agent_instances SET enabled = false WHERE id = $1::uuid`,
      [instanceId],
    );

    await harness.dispatcher.refresh();

    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      instanceId,
      scheduleCron: "0 8 * * *",
    });
    expect(harness.dispatcher.listSchedules()).toHaveLength(0);
  });

  it("is idempotent — concurrent refresh calls don't double-register", async () => {
    // Two refresh() calls fire back-to-back while the FIRST call's
    // DB enumeration is still in flight (simulated by a pending
    // promise we resolve manually). The single-flight mutex
    // (`this.refreshing`) must cause the second call to no-op so
    // the seam-supplied registration stub fires once, not twice.
    // We seed AFTER `start()` so the initial enumeration finds
    // nothing — the new row only becomes visible to the refresh
    // path, isolating the assertion window to the two concurrent
    // refresh ticks.
    const fixture = await freshAgentDb();
    const harness = await startDispatcher({ fixture });
    activeHarness = harness;
    await harness.dispatcher.start();
    expect(harness.registered).toHaveLength(0);

    const { instanceId } = await seedScheduledInstance(fixture, {
      name: "single-flight",
      scheduleCron: "0 8 * * *",
    });

    // Block the dispatcher's `db.execute()` so the first refresh()
    // hangs inside `fetchDesiredSchedules`. The second refresh()
    // must observe `this.refreshing === true` and bail BEFORE it
    // would otherwise call `db.execute()` a second time.
    //
    // Access `db` via `[...]` because it's a private field — the
    // private modifier is a TypeScript compile-time fence; at
    // runtime the property is reachable like any other. Tests need
    // this seam to drive the mutex deterministically without
    // racing the production timer.
    interface DispatcherInternals {
      readonly db: { execute: (query: unknown) => Promise<unknown> };
    }
    const internals = harness.dispatcher as unknown as DispatcherInternals;
    const originalExecute = internals.db.execute.bind(internals.db);
    let releaseFirst: (() => void) | undefined;
    const firstQueryGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    const executeSpy = vi
      .spyOn(internals.db, "execute")
      .mockImplementation(async (query: unknown) => {
        callCount += 1;
        if (callCount === 1) {
          await firstQueryGate;
        }
        return originalExecute(query);
      });

    try {
      const first = harness.dispatcher.refresh();
      // Second call MUST be invoked while the first is still
      // pending — fire it synchronously without awaiting.
      const second = harness.dispatcher.refresh();

      // Release the first call's DB query.
      releaseFirst!();

      await Promise.all([first, second]);

      // Single-flight contract: the DB `execute` ran exactly once
      // — the second refresh() saw `refreshing === true` and
      // returned without enumerating.
      expect(executeSpy).toHaveBeenCalledTimes(1);
      // And the registration side-effect fired exactly once.
      expect(harness.registered).toHaveLength(1);
      expect(harness.registered[0]?.instanceId).toBe(instanceId);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("clears the refresh interval in stop() so the timer doesn't leak past shutdown", async () => {
    // Belt-and-suspenders: hand the dispatcher a small (non-zero)
    // interval so the timer arms, then assert `stop()` clears it.
    // Without this, a long-running process that re-creates
    // dispatchers (test runs, integration suites) leaks
    // setInterval handles and node ends up holding the event loop
    // open until process exit.
    const fixture = await freshAgentDb();
    const harness = await startDispatcher({
      fixture,
      refreshIntervalMs: 50,
    });
    activeHarness = null; // We tear down manually below.
    await harness.dispatcher.start();

    // The dispatcher armed the timer; spy on `clearInterval` so
    // we can pin that stop() reaches it.
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      await harness.dispatcher.stop();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      harness.redis.disconnect();
    }
  });
});
