/**
 * `startEngine` — generic harness used by both engine-ingestion
 * and engine-self-operating. Verifies the boot path: factories
 * fire, server.listen happens, returned StartedEngine exposes
 * the registry + an idempotent close.
 */
import { describe, expect, it, vi } from "vitest";

import {
  PipelineRegistry,
  startEngine,
  type StartConfig,
  type StartDb,
  type StartRedis,
  type StartServer,
} from "../../src/engine-scaffold/index.js";

interface TestConfig extends StartConfig {
  readonly extraField: string;
}

function fakeDb(): StartDb {
  return {
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeRedis(): StartRedis {
  return {
    ping: vi.fn().mockResolvedValue("PONG"),
    disconnect: vi.fn(),
  };
}

function fakeServer(): StartServer {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const baseConfig: TestConfig = {
  databaseUrl: "postgres://x",
  redisUrl: "redis://x",
  port: 8080,
  extraField: "value",
};

describe("startEngine", () => {
  it("constructs db + redis + server and returns the StartedEngine", async () => {
    const db = fakeDb();
    const redis = fakeRedis();
    const server = fakeServer();
    const engine = await startEngine({
      config: baseConfig,
      dbFactory: () => db,
      redisFactory: () => redis,
      serverFactory: () => server,
    });
    expect(engine.db).toBe(db);
    expect(engine.redis).toBe(redis);
    expect(engine.app).toBe(server);
    expect(engine.config).toBe(baseConfig);
    expect(server.listen).toHaveBeenCalledWith({ host: "0.0.0.0", port: 8080 });
    await engine.close();
  });

  it("preserves engine-specific config fields through the generic", async () => {
    const engine = await startEngine({
      config: baseConfig,
      dbFactory: fakeDb,
      redisFactory: fakeRedis,
      serverFactory: fakeServer,
    });
    expect(engine.config.extraField).toBe("value");
    await engine.close();
  });

  it("uses caller-provided registry when set", async () => {
    const registry = new PipelineRegistry();
    const engine = await startEngine({
      config: baseConfig,
      registry,
      dbFactory: fakeDb,
      redisFactory: fakeRedis,
      serverFactory: fakeServer,
    });
    expect(engine.registry).toBe(registry);
    await engine.close();
  });

  it("close() is idempotent — concurrent calls share the same Promise", async () => {
    const db = fakeDb();
    const redis = fakeRedis();
    const server = fakeServer();
    const engine = await startEngine({
      config: baseConfig,
      dbFactory: () => db,
      redisFactory: () => redis,
      serverFactory: () => server,
    });
    const a = engine.close();
    const b = engine.close();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(db.end).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("tears down db + redis when listen throws (resource safety)", async () => {
    const db = fakeDb();
    const redis = fakeRedis();
    const server = fakeServer();
    (server.listen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("EADDRINUSE"),
    );
    await expect(
      startEngine({
        config: baseConfig,
        dbFactory: () => db,
        redisFactory: () => redis,
        serverFactory: () => server,
      }),
    ).rejects.toThrow("EADDRINUSE");
    expect(db.end).toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it("tears down db when redisFactory throws (copilot #20)", async () => {
    const db = fakeDb();
    await expect(
      startEngine({
        config: baseConfig,
        dbFactory: () => db,
        redisFactory: () => {
          throw new Error("redis-down");
        },
        serverFactory: fakeServer,
      }),
    ).rejects.toThrow("redis-down");
    expect(db.end).toHaveBeenCalled();
  });

  it("tears down db + redis when serverFactory throws (copilot #20)", async () => {
    const db = fakeDb();
    const redis = fakeRedis();
    await expect(
      startEngine({
        config: baseConfig,
        dbFactory: () => db,
        redisFactory: () => redis,
        serverFactory: () => {
          throw new Error("server-build-failed");
        },
      }),
    ).rejects.toThrow("server-build-failed");
    expect(db.end).toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it("rethrows the dbFactory error untouched (no resources to tear down yet)", async () => {
    await expect(
      startEngine({
        config: baseConfig,
        dbFactory: () => {
          throw new Error("db-down");
        },
        redisFactory: fakeRedis,
        serverFactory: fakeServer,
      }),
    ).rejects.toThrow("db-down");
  });

  it("probeExtender lets the consumer add probes (e.g. self-op's wikiAdapter probe)", async () => {
    let receivedProbes: Record<string, unknown> = {};
    await startEngine({
      config: baseConfig,
      dbFactory: fakeDb,
      redisFactory: fakeRedis,
      serverFactory: (probes) => {
        receivedProbes = probes;
        return fakeServer();
      },
      probeExtender: (probes) => ({
        ...probes,
        custom: async () => ({ ok: true }),
      }),
    });
    expect(Object.keys(receivedProbes).sort()).toEqual([
      "custom",
      "postgres",
      "redis",
    ]);
  });
});
