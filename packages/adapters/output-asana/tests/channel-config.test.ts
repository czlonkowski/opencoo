/**
 * Asana channel-config schema tests (PR-W5, phase-a appendix #14).
 *
 * Pin matrix:
 *   - `project_gid` is required; other fields are optional.
 *   - `assignee_gid`, `section_gid` accept non-empty strings.
 *   - `due_date_policy` is an enum `"today" | "none"`; bad
 *     values are rejected with a clear validation error.
 *   - `due_date_policy` defaults to `"today"` at parse time
 *     when omitted (mirrors the n8n baseline).
 *   - `title_prefix` defaults to `"[COO] Raport -- "` at parse
 *     time when omitted; empty-string is preserved (transformer
 *     uses that as a distinct signal to fall back to the
 *     date-then-summary shape).
 *   - `.strict()` rejects unknown keys (defense-in-depth: an
 *     agent-supplied config cannot smuggle an extra field).
 *
 * The JSON-schema descriptor `asanaChannelConfigJsonSchema`
 * mirrors the Zod surface for the UI's form renderer; tests
 * confirm both stay in lockstep.
 */
import { describe, expect, it } from "vitest";

import {
  ASANA_CHANNEL_CONFIG_DEFAULTS,
  asanaChannelConfigJsonSchema,
  asanaChannelConfigSchema,
} from "../src/channel-config.js";

describe("asanaChannelConfigSchema", () => {
  it("accepts the minimal config with just project_gid (defaults applied)", () => {
    const parsed = asanaChannelConfigSchema.parse({
      project_gid: "1214005588882595",
    });
    expect(parsed.project_gid).toBe("1214005588882595");
    expect(parsed.assignee_gid).toBeUndefined();
    expect(parsed.section_gid).toBeUndefined();
    expect(parsed.due_date_policy).toBe(
      ASANA_CHANNEL_CONFIG_DEFAULTS.due_date_policy,
    );
    expect(parsed.title_prefix).toBe(
      ASANA_CHANNEL_CONFIG_DEFAULTS.title_prefix,
    );
  });

  it("requires project_gid", () => {
    expect(() => asanaChannelConfigSchema.parse({})).toThrow();
  });

  it("accepts assignee_gid + section_gid as optional non-empty strings", () => {
    const parsed = asanaChannelConfigSchema.parse({
      project_gid: "p-1",
      assignee_gid: "u-42",
      section_gid: "sec-9",
    });
    expect(parsed.assignee_gid).toBe("u-42");
    expect(parsed.section_gid).toBe("sec-9");
  });

  it("rejects empty-string assignee_gid (matches required-min)", () => {
    expect(() =>
      asanaChannelConfigSchema.parse({
        project_gid: "p-1",
        assignee_gid: "",
      }),
    ).toThrow();
  });

  it("rejects empty-string section_gid", () => {
    expect(() =>
      asanaChannelConfigSchema.parse({
        project_gid: "p-1",
        section_gid: "",
      }),
    ).toThrow();
  });

  it("accepts due_date_policy='today'", () => {
    const parsed = asanaChannelConfigSchema.parse({
      project_gid: "p-1",
      due_date_policy: "today",
    });
    expect(parsed.due_date_policy).toBe("today");
  });

  it("accepts due_date_policy='none'", () => {
    const parsed = asanaChannelConfigSchema.parse({
      project_gid: "p-1",
      due_date_policy: "none",
    });
    expect(parsed.due_date_policy).toBe("none");
  });

  it("rejects invalid due_date_policy values with a clear error", () => {
    const result = asanaChannelConfigSchema.safeParse({
      project_gid: "p-1",
      due_date_policy: "tomorrow",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/due_date_policy/);
    }
  });

  it("defaults due_date_policy to 'today' when omitted", () => {
    const parsed = asanaChannelConfigSchema.parse({ project_gid: "p-1" });
    expect(parsed.due_date_policy).toBe("today");
  });

  it("accepts custom title_prefix", () => {
    const parsed = asanaChannelConfigSchema.parse({
      project_gid: "p-1",
      title_prefix: "opencoo daily — ",
    });
    expect(parsed.title_prefix).toBe("opencoo daily — ");
  });

  it("preserves empty-string title_prefix (caller-side signal)", () => {
    const parsed = asanaChannelConfigSchema.parse({
      project_gid: "p-1",
      title_prefix: "",
    });
    expect(parsed.title_prefix).toBe("");
  });

  it("defaults title_prefix to '[COO] Raport -- ' when omitted", () => {
    const parsed = asanaChannelConfigSchema.parse({ project_gid: "p-1" });
    expect(parsed.title_prefix).toBe("[COO] Raport -- ");
  });

  it("rejects title_prefix longer than 200 chars (bound on operator input)", () => {
    expect(() =>
      asanaChannelConfigSchema.parse({
        project_gid: "p-1",
        title_prefix: "x".repeat(201),
      }),
    ).toThrow();
  });

  it("rejects unknown keys (.strict — defense-in-depth)", () => {
    expect(() =>
      asanaChannelConfigSchema.parse({
        project_gid: "p-1",
        __smuggled: "x",
      }),
    ).toThrow();
  });
});

describe("asanaChannelConfigJsonSchema (UI form descriptor)", () => {
  it("declares the same properties as the Zod schema", () => {
    expect(Object.keys(asanaChannelConfigJsonSchema.properties).sort()).toEqual(
      [
        "assignee_gid",
        "due_date_policy",
        "project_gid",
        "section_gid",
        "title_prefix",
      ],
    );
  });

  it("project_gid is the only required field", () => {
    expect(asanaChannelConfigJsonSchema.required).toEqual(["project_gid"]);
  });

  it("each property is a string-typed input the dynamic form can render", () => {
    for (const prop of Object.values(asanaChannelConfigJsonSchema.properties)) {
      expect(prop.type).toBe("string");
    }
  });

  it("documents due_date_policy options + title_prefix default", () => {
    expect(
      asanaChannelConfigJsonSchema.properties.due_date_policy.description,
    ).toMatch(/today.*none/);
    expect(
      asanaChannelConfigJsonSchema.properties.title_prefix.description,
    ).toMatch(/Raport/);
  });
});
