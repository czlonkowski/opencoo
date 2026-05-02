/**
 * Binding-config schema tests for PR-G additions:
 *   - snapshotMode: 'on-event' | 'periodic' | 'off', default 'on-event'
 *   - optFields: string[], default to six PoC fields
 */
import { describe, it, expect } from "vitest";

import { asanaBindingConfigSchema } from "../src/index.js";
import { DEFAULT_OPT_FIELDS } from "../src/asana-client.js";

describe("asanaBindingConfigSchema — snapshotMode", () => {
  it("defaults snapshotMode to 'on-event'", () => {
    const parsed = asanaBindingConfigSchema.parse({ projectGid: "p" });
    expect(parsed.snapshotMode).toBe("on-event");
  });

  it("accepts snapshotMode='on-event'", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "on-event" }),
    ).not.toThrow();
  });

  it("accepts snapshotMode='periodic'", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "periodic" }),
    ).not.toThrow();
  });

  it("accepts snapshotMode='off'", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "off" }),
    ).not.toThrow();
  });

  it("rejects unknown snapshotMode values", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({ projectGid: "p", snapshotMode: "always" }),
    ).toThrow();
  });
});

describe("asanaBindingConfigSchema — optFields", () => {
  it("defaults optFields to the six PoC fields", () => {
    const parsed = asanaBindingConfigSchema.parse({ projectGid: "p" });
    expect(parsed.optFields).toEqual([...DEFAULT_OPT_FIELDS]);
  });

  it("accepts custom optFields", () => {
    const custom = ["name", "completed"];
    const parsed = asanaBindingConfigSchema.parse({
      projectGid: "p",
      optFields: custom,
    });
    expect(parsed.optFields).toEqual(custom);
  });

  it("rejects non-string elements in optFields", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({
        projectGid: "p",
        optFields: [42, "name"],
      }),
    ).toThrow();
  });
});

describe("asanaBindingConfigSchema — combined PR-G fields", () => {
  it("parses a full valid config with all PR-G fields", () => {
    const parsed = asanaBindingConfigSchema.parse({
      projectGid: "project-123",
      snapshotMode: "periodic",
      optFields: ["name", "completed", "due_on"],
      monitoredProjectGids: ["proj-a", "proj-b"],
      lightSummaryEnabled: true,
      reviewMode: "auto",
    });

    expect(parsed.snapshotMode).toBe("periodic");
    expect(parsed.optFields).toEqual(["name", "completed", "due_on"]);
    expect(parsed.monitoredProjectGids).toEqual(["proj-a", "proj-b"]);
    expect(parsed.lightSummaryEnabled).toBe(true);
  });

  it("still rejects unknown fields (.strict remains)", () => {
    expect(() =>
      asanaBindingConfigSchema.parse({
        projectGid: "p",
        snapshotMode: "on-event",
        unknownKey: "should-fail",
      }),
    ).toThrow();
  });
});
