/**
 * `@opencoo/shared/engine-scaffold/config` — engine-agnostic
 * helpers for boot-time config loading. Each consumer (engine-
 * ingestion, engine-self-operating) builds its own
 * `loadEngineConfig` on top of these helpers and a
 * package-specific Zod schema.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BaseEngineConfigSchema,
  parseEngineConfig,
  parseEnginePort,
  readWithFile,
  requireWithFile,
} from "../../src/engine-scaffold/config.js";

describe("readWithFile — Docker-secrets precedence", () => {
  it("returns the inline env var when only the inline form is set", () => {
    expect(readWithFile({ FOO: "inline" }, "FOO")).toBe("inline");
  });

  it("returns the file contents when only the _FILE form is set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-cfg-"));
    const filePath = path.join(tmp, "secret");
    fs.writeFileSync(filePath, "from-disk\n");
    expect(readWithFile({ FOO_FILE: filePath }, "FOO")).toBe("from-disk");
  });

  it("_FILE wins when BOTH are set (production-safe Docker-secrets convention)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-cfg-"));
    const filePath = path.join(tmp, "secret");
    fs.writeFileSync(filePath, "from-disk");
    expect(
      readWithFile({ FOO: "inline", FOO_FILE: filePath }, "FOO"),
    ).toBe("from-disk");
  });

  it("strips a single trailing newline run from the file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-cfg-"));
    const filePath = path.join(tmp, "secret");
    fs.writeFileSync(filePath, "value\n\n");
    expect(readWithFile({ FOO_FILE: filePath }, "FOO")).toBe("value");
  });

  it("returns undefined when neither form is set", () => {
    expect(readWithFile({}, "FOO")).toBeUndefined();
  });
});

describe("requireWithFile — engine-named errors", () => {
  it("returns the value when set", () => {
    expect(requireWithFile({ FOO: "v" }, "FOO", "ingestion")).toBe("v");
  });

  it("throws naming both inline and _FILE forms", () => {
    expect(() => requireWithFile({}, "DATABASE_URL", "ingestion")).toThrow(
      /DATABASE_URL.*DATABASE_URL_FILE/i,
    );
  });

  it("includes the engine name in the error message", () => {
    expect(() => requireWithFile({}, "DATABASE_URL", "self-op")).toThrow(
      /engine-self-op config/,
    );
  });
});

describe("parseEnginePort", () => {
  it("returns the default when PORT is unset", () => {
    expect(parseEnginePort({}, "ingestion")).toBe(8080);
  });

  it("uses a caller-supplied default", () => {
    expect(parseEnginePort({}, "ingestion", 9000)).toBe(9000);
  });

  it("returns a parsed integer when PORT is a numeric string", () => {
    expect(parseEnginePort({ PORT: "3000" }, "ingestion")).toBe(3000);
  });

  it("throws on a non-numeric PORT, naming the engine", () => {
    expect(() => parseEnginePort({ PORT: "x" }, "self-op")).toThrow(
      /engine-self-op config: PORT/,
    );
  });

  it("throws on a negative PORT", () => {
    expect(() => parseEnginePort({ PORT: "-1" }, "ingestion")).toThrow();
  });
});

describe("parseEngineConfig — generic Zod gate", () => {
  it("returns the typed result when the schema accepts the input", () => {
    const result = parseEngineConfig({
      engineName: "ingestion",
      fields: {
        databaseUrl: "postgres://x",
        redisUrl: "redis://x",
        port: 8080,
        logLevel: "info",
        nodeEnv: "production",
      },
      schema: BaseEngineConfigSchema,
    });
    expect(result.databaseUrl).toBe("postgres://x");
    expect(result.port).toBe(8080);
  });

  it("throws when the schema rejects the input (Zod error bubbles up)", () => {
    expect(() =>
      parseEngineConfig({
        engineName: "ingestion",
        fields: { databaseUrl: "" },
        schema: BaseEngineConfigSchema,
      }),
    ).toThrow();
  });

  it("works with a consumer-extended schema (e.g. ingestion's giteaUrl)", () => {
    const ExtendedSchema = BaseEngineConfigSchema.extend({
      giteaUrl: z.string().url(),
    });
    type Extended = z.infer<typeof ExtendedSchema>;
    const result: Extended = parseEngineConfig<Extended>({
      engineName: "ingestion",
      fields: {
        databaseUrl: "postgres://x",
        redisUrl: "redis://x",
        giteaUrl: "https://gitea.test",
        port: 8080,
        logLevel: "info",
        nodeEnv: "test",
      },
      schema: ExtendedSchema,
    });
    expect(result.giteaUrl).toBe("https://gitea.test");
  });
});
