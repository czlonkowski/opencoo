/**
 * Per-(agent, adapter) output transformer tests (PR-W2,
 * phase-a appendix #13 — closes G2).
 *
 * Pin matrix:
 *   - Per-(agent, adapter) pair happy path.
 *   - HTML entity escaping for the five chars (& < > " ').
 *   - Sibling-not-nested rule: `<h2>` and `<ul>` live at the
 *     `<body>` level, never inside each other.
 *   - 32 KB cap enforcement on the rendered html_notes body.
 *   - Unknown-agent fallback to `mergeAsanaPayloadGeneric` /
 *     `mergeWebhookPayloadGeneric`.
 *   - `mergePayloadFor` dispatcher routing per (agent, adapter)
 *     combo.
 *   - `OutputTransformerNotFoundError` thrown when both
 *     agent-specific AND generic transformers are absent for
 *     the adapter.
 *
 * THREAT-MODEL §3.6 invariant 11: transformers see ONLY
 * `(agentOutput, channelConfig)`. There is no credential
 * surface to assert here — by design — but every test
 * asserts the produced payload contains no smuggled bytes.
 */
import { describe, expect, it } from "vitest";

import {
  OutputTransformerNotFoundError,
  escapeHtml,
  heartbeatToAsana,
  heartbeatToWebhook,
  lintToAsana,
  lintToWebhook,
  mergeAsanaPayloadGeneric,
  mergePayloadFor,
  mergeWebhookPayloadGeneric,
  surfacerToAsana,
  surfacerToWebhook,
} from "../src/provision/output-transformers.js";

const PROJECT_GID = "1214005588882595";
const CHANNEL_CONFIG = { project_gid: PROJECT_GID } as const;

// PR-W5 (phase-a appendix #14) — fixed clock for deterministic
// date assertions on title prefix + dueOn fields.
const FIXED_NOW = new Date("2026-05-13T08:00:00Z");
const FIXED_TODAY = "2026-05-13";

describe("escapeHtml", () => {
  it("escapes the standard five entity chars", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes only HTML-significant chars (passes through unicode)", () => {
    expect(escapeHtml("Łódź — ąęć")).toBe("Łódź — ąęć");
  });
});

describe("heartbeatToAsana", () => {
  it("happy path: alerts become sibling h2 + body-text + ul, summary leads as <h1>", () => {
    // PR-W5 (phase-a appendix #14) — title is now the date-templated
    // prefix shape (default `[COO] Raport -- YYYY-MM-DD`); the
    // summary leads the body as `<h1>`.
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        version: "1.0",
        summary: "Two alerts today",
        alerts: [
          {
            priority: 1,
            title: "Q3 deck slipping",
            body: "Sales asked for the deck on 2026-09-30.",
            citations: ["wiki-executive/q3-plan.md"],
          },
          {
            priority: 2,
            title: "Hiring pause",
            body: "Operations froze new hires this week.",
            citations: [
              "wiki-hr/headcount.md",
              "wiki-ops/budget-2026.md",
            ],
          },
        ],
      },
    });
    expect(payload.projectGid).toBe(PROJECT_GID);
    expect(payload.title).toBe(`[COO] Raport -- ${FIXED_TODAY}`);
    expect(payload.htmlNotes).toBeDefined();
    expect(payload.notes).toBeUndefined();
    const html = payload.htmlNotes!;
    // Root is <body>.
    expect(html.startsWith("<body>")).toBe(true);
    expect(html.endsWith("</body>")).toBe(true);
    // PR-W5: summary leads the body as <h1>.
    expect(html.startsWith(`<body><h1>Two alerts today</h1>`)).toBe(true);
    // Each alert produces one h2 + bare-text body + one ul.
    // PR-Y5: <p> dropped (Asana html_notes rejects it).
    expect(html.match(/<h2>/g)?.length).toBe(2);
    expect(html).not.toMatch(/<p\b/);
    expect(html.match(/<ul>/g)?.length).toBe(2);
    // Specific content present.
    expect(html).toContain("Q3 deck slipping");
    expect(html).toContain("wiki-executive/q3-plan.md");
    // PR-W5: dueOn defaults to today.
    expect(payload.dueOn).toBe(FIXED_TODAY);
  });

  it("siblings rule: h2 NEVER appears inside ul, ul NEVER appears inside h2", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "x",
        alerts: [
          {
            title: "T1",
            body: "B1",
            citations: ["c1", "c2"],
          },
        ],
      },
    });
    const html = payload.htmlNotes!;
    expect(html).not.toMatch(/<ul>[\s\S]*<h2>[\s\S]*<\/h2>[\s\S]*<\/ul>/);
    expect(html).not.toMatch(/<h2>[\s\S]*<ul>[\s\S]*<\/ul>[\s\S]*<\/h2>/);
    expect(html).not.toMatch(/<li>[\s\S]*<h2>/);
  });

  it("HTML escapes alert body text — & < > \" ' are not interpreted as tags", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "s",
        alerts: [
          {
            title: "<script>alert(1)</script>",
            body: "Q3 R&D plan — \"high\" priority; what's next?",
            citations: ["a<b>c"],
          },
        ],
      },
    });
    const html = payload.htmlNotes!;
    // Smuggled <script> in title is escaped — no raw <script> appears.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // & " ' all escaped in body.
    expect(html).toContain("R&amp;D");
    expect(html).toContain("&quot;high&quot;");
    expect(html).toContain("what&#39;s next");
    // Citation `<` is escaped.
    expect(html).toContain("a&lt;b&gt;c");
  });

  it("renders empty-alerts case with default bare text (PR-Y5: no <p>)", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "", alerts: [] },
    });
    expect(payload.htmlNotes).toContain("No alerts today.");
    expect(payload.htmlNotes).not.toMatch(/<p\b/);
    // PR-W5: empty summary still gets the date-prefixed default title.
    expect(payload.title).toBe(`[COO] Raport -- ${FIXED_TODAY}`);
  });

  it("title caps at 500 chars (long custom title_prefix is clipped)", () => {
    // PR-W5: title is now the date-prefixed shape; we cap the whole
    // title at 500 chars to match the payload schema's .max(500).
    // The Zod schema bounds title_prefix at 200 chars; combined with
    // the 10-char ISO date that's well under 500. The cap matters
    // when the schema is bypassed (e.g. legacy channel-config rows);
    // we simulate that here by feeding the transformer a raw
    // channel-config record with an oversized prefix.
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: {
        project_gid: PROJECT_GID,
        title_prefix: "x".repeat(600),
      },
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.title.length).toBe(500);
  });

  it("forwards assignee_gid from channel config when present", () => {
    const payload = heartbeatToAsana({
      channelConfig: { project_gid: PROJECT_GID, assignee_gid: "u-42" },
      agentOutput: { summary: "s", alerts: [] },
    });
    expect(payload.assigneeGid).toBe("u-42");
  });

  it("omits assignee_gid when the channel config field is missing or empty", () => {
    const payload = heartbeatToAsana({
      channelConfig: { project_gid: PROJECT_GID, assignee_gid: "" },
      agentOutput: { summary: "s", alerts: [] },
    });
    expect(payload.assigneeGid).toBeUndefined();
  });

  it("throws when channel config is missing project_gid", () => {
    expect(() =>
      heartbeatToAsana({
        channelConfig: {} as never,
        agentOutput: { summary: "s", alerts: [] },
      }),
    ).toThrow(/project_gid/);
  });

  it("caps total html_notes at 32 KB", () => {
    // Build an output that produces an html_notes body larger
    // than the 32 KB cap. ~33 KB body of repeated alert text.
    const giantBody = "x".repeat(50_000);
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "huge",
        alerts: [{ title: "t", body: giantBody, citations: [] }],
      },
    });
    expect(payload.htmlNotes!.length).toBeLessThanOrEqual(32_768);
  });

  // ── Copilot triage #4 — sibling-boundary truncation ────────────────
  //
  // The old byte-walk `capHtmlBody` could slice the final `</body>`
  // close in half and could cut mid-HTML-entity (e.g. between
  // `&amp` and `;`), producing invalid XML that Asana 400s on.
  // The replacement truncates at SIBLING boundaries with a
  // reserved budget for the wrapper + a marker. These tests pin
  // that contract.

  it("truncates at sibling boundaries — never splits a tag or entity", () => {
    // A small first sibling (h2) + a giant second sibling (p) that
    // pushes the running total over the cap. The truncation must
    // drop the giant <p> wholesale, not slice into it.
    const giantBody = "x".repeat(50_000);
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "huge",
        alerts: [{ title: "T", body: giantBody, citations: [] }],
      },
    });
    const html = payload.htmlNotes!;
    // Body wrapper intact — the closing tag wasn't sliced.
    expect(html.startsWith("<body>")).toBe(true);
    expect(html.endsWith("</body>")).toBe(true);
    // No bare half-tag (we'd see e.g. `<p` without a closing `>`).
    expect(html).not.toMatch(/<[a-zA-Z][^>]*$/);
    // No half-escaped entity (e.g. `&am` or `&amp` without `;`).
    expect(html).not.toMatch(/&[a-zA-Z]+$/);
    // The small first sibling survived.
    expect(html).toContain("<h2>T</h2>");
    // The giant body was dropped wholesale — no run of 1000 xs.
    expect(html).not.toMatch(/x{1000}/);
  });

  it("appends a truncation marker when at least one sibling was dropped", () => {
    const giantBody = "x".repeat(50_000);
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "huge",
        alerts: [{ title: "T", body: giantBody, citations: [] }],
      },
    });
    // PR-Y5: truncation marker switched from <p> to <em> (Asana rejects <p>).
    expect(payload.htmlNotes!).toContain("<em>(truncated…)</em>");
  });

  it("does NOT add a truncation marker when content fits under the cap", () => {
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "small",
        alerts: [{ title: "T", body: "B", citations: ["c1"] }],
      },
    });
    expect(payload.htmlNotes!).not.toContain("(truncated");
  });

  it("produces a parseable body — open/close tag counts balance, no half-tags", () => {
    // Use many medium siblings so the cap kicks in mid-stream and
    // we can verify the surviving HTML is well-formed.
    const alerts = Array.from({ length: 200 }, (_, i) => ({
      title: `Alert ${i}`,
      body: "y".repeat(400),
      citations: ["c"],
    }));
    const payload = heartbeatToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "many", alerts },
    });
    const html = payload.htmlNotes!;
    // Under cap.
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(32_768);
    // Body wrapper intact.
    expect(html.startsWith("<body>")).toBe(true);
    expect(html.endsWith("</body>")).toBe(true);
    // Each opening tag has its closing pair (PR-Y5: <p> dropped).
    // PR-W5: <h1> (summary lead) also balanced.
    const countTag = (re: RegExp): number => (html.match(re) ?? []).length;
    expect(countTag(/<h1>/g)).toBe(countTag(/<\/h1>/g));
    expect(countTag(/<h2>/g)).toBe(countTag(/<\/h2>/g));
    expect(html).not.toMatch(/<p\b/);
    expect(countTag(/<ul>/g)).toBe(countTag(/<\/ul>/g));
    expect(countTag(/<li>/g)).toBe(countTag(/<\/li>/g));
    expect(countTag(/<em>/g)).toBe(countTag(/<\/em>/g));
    expect(countTag(/<body>/g)).toBe(1);
    expect(countTag(/<\/body>/g)).toBe(1);
    // Truncation marker present (we built much more than 32 KB of siblings).
    expect(html).toContain("<em>(truncated…)</em>");
  });

  // ── PR-W5 (phase-a appendix #14) — title shape, dueOn, summary lead ──

  it("PR-W5 title: default prefix '[COO] Raport -- ' + injected today's date", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "Sales priority", alerts: [] },
    });
    expect(payload.title).toBe(`[COO] Raport -- ${FIXED_TODAY}`);
  });

  it("PR-W5 title: custom title_prefix from channel-config is honored", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: {
        project_gid: PROJECT_GID,
        title_prefix: "opencoo daily — ",
      },
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.title).toBe(`opencoo daily — ${FIXED_TODAY}`);
  });

  it("PR-W5 title: empty-string prefix falls back to '${date} — ${summary[0..100]}'", () => {
    const longSummary = "A".repeat(150);
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: { project_gid: PROJECT_GID, title_prefix: "" },
      agentOutput: { summary: longSummary, alerts: [] },
    });
    // Date · em-dash · first 100 chars of summary (not the full 150).
    expect(payload.title).toBe(`${FIXED_TODAY} — ${"A".repeat(100)}`);
  });

  it("PR-W5 title: empty-string prefix + no summary degrades to bare date", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: { project_gid: PROJECT_GID, title_prefix: "" },
      agentOutput: { summary: "", alerts: [] },
    });
    expect(payload.title).toBe(FIXED_TODAY);
  });

  it("PR-W5 dueOn: defaults to today (channel-config omits due_date_policy)", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.dueOn).toBe(FIXED_TODAY);
  });

  it("PR-W5 dueOn: explicit 'today' policy sets today", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: {
        project_gid: PROJECT_GID,
        due_date_policy: "today",
      },
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.dueOn).toBe(FIXED_TODAY);
  });

  it("PR-W5 dueOn: 'none' policy omits dueOn entirely", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: {
        project_gid: PROJECT_GID,
        due_date_policy: "none",
      },
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.dueOn).toBeUndefined();
  });

  it("PR-W5 assignee: passes through when channel-config sets assignee_gid", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: { project_gid: PROJECT_GID, assignee_gid: "u-99" },
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.assigneeGid).toBe("u-99");
  });

  it("PR-W5 assignee: omitted when channel-config has no assignee_gid", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.assigneeGid).toBeUndefined();
  });

  it("PR-W5 sectionGid: passes through when channel-config sets section_gid", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: { project_gid: PROJECT_GID, section_gid: "sec-123" },
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.sectionGid).toBe("sec-123");
  });

  it("PR-W5 sectionGid: omitted when channel-config has no section_gid", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "x", alerts: [] },
    });
    expect(payload.sectionGid).toBeUndefined();
  });

  it("PR-W5 body lead: <body><h1>summary</h1> precedes per-alert <h2> blocks", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "Top of mind",
        alerts: [
          { title: "Alert A", body: "Body A", citations: [] },
          { title: "Alert B", body: "Body B", citations: [] },
        ],
      },
    });
    const html = payload.htmlNotes!;
    expect(html.startsWith("<body><h1>Top of mind</h1>")).toBe(true);
    // h1 strictly precedes the first h2 in the document order.
    const h1End = html.indexOf("</h1>");
    const h2Start = html.indexOf("<h2>");
    expect(h1End).toBeGreaterThanOrEqual(0);
    expect(h2Start).toBeGreaterThan(h1End);
  });

  it("PR-W5 body lead: summary is HTML-escaped in <h1>", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "<script>x</script> & \"q\" 'a'",
        alerts: [],
      },
    });
    const html = payload.htmlNotes!;
    expect(html).toContain(
      "<h1>&lt;script&gt;x&lt;/script&gt; &amp; &quot;q&quot; &#39;a&#39;</h1>",
    );
    // No raw <script> bleed.
    expect(html).not.toContain("<script>");
  });

  it("PR-W5 body lead: empty summary skips the <h1> lead but body still wraps", () => {
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "",
        alerts: [{ title: "T", body: "B", citations: [] }],
      },
    });
    const html = payload.htmlNotes!;
    expect(html).not.toContain("<h1>");
    expect(html.startsWith("<body>")).toBe(true);
    expect(html).toContain("<h2>T</h2>");
  });

  it("PR-W5 Y5 invariants preserved: no <p>, <hr/> before truncation marker, body wrapper intact", () => {
    const giantBody = "x".repeat(50_000);
    const payload = heartbeatToAsana({
      now: FIXED_NOW,
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        summary: "big",
        alerts: [{ title: "T", body: giantBody, citations: [] }],
      },
    });
    const html = payload.htmlNotes!;
    // Y5: no <p>.
    expect(html).not.toMatch(/<p\b/);
    // Y5: <hr/> separator immediately precedes truncation marker.
    expect(html).toMatch(/<hr\/>\s*<em>\(truncated…\)<\/em>/);
    // <body>...</body> wrapper intact.
    expect(html.startsWith("<body>")).toBe(true);
    expect(html.endsWith("</body>")).toBe(true);
  });
});

describe("lintToAsana", () => {
  it("renders findings as sibling h2 + bare-text + ul triples (PR-Y5: no <p>)", () => {
    const payload = lintToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        findings: [
          {
            kind: "contradiction",
            title: "Two sources disagree",
            body: "wiki-hr says X; wiki-ops says Y.",
            citations: ["wiki-hr/x.md", "wiki-ops/y.md"],
          },
        ],
      },
    });
    expect(payload.title).toMatch(/^Wiki lint findings — \d{4}-\d{2}-\d{2}$/);
    const html = payload.htmlNotes!;
    expect(html.startsWith("<body>")).toBe(true);
    expect(html).toContain("<h2>Two sources disagree</h2>");
    expect(html).toContain("<li>wiki-hr/x.md</li>");
  });

  it("renders empty-findings case with bare default text (PR-Y5: no <p>)", () => {
    const payload = lintToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { findings: [] },
    });
    expect(payload.htmlNotes).toContain("No findings.");
  });

  it("escapes finding title + body", () => {
    const payload = lintToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        findings: [
          {
            title: "<img src=x>",
            body: "edge & corner",
          },
        ],
      },
    });
    expect(payload.htmlNotes).not.toContain("<img");
    expect(payload.htmlNotes).toContain("&lt;img");
    expect(payload.htmlNotes).toContain("edge &amp; corner");
  });
});

describe("surfacerToAsana", () => {
  it("uses topic as title and renders rationale + citations", () => {
    const payload = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {
        topic: "Automate weekly digest",
        rationale: "Sales asked for a digest in 4 of last 6 standups.",
        citations: ["wiki-executive/standup-2026-04-30.md"],
      },
    });
    expect(payload.title).toBe("Automate weekly digest");
    expect(payload.htmlNotes).toContain("<h2>Rationale</h2>");
    expect(payload.htmlNotes).toContain("<h2>Citations</h2>");
  });

  it("falls back to title or summary when topic is missing", () => {
    const t = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { title: "T1", rationale: "r" },
    });
    expect(t.title).toBe("T1");
    const s = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "S1", rationale: "r" },
    });
    expect(s.title).toBe("S1");
  });

  it("renders default bare text when no rationale or citations are present (PR-Y5: no <p>)", () => {
    const payload = surfacerToAsana({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { topic: "t" },
    });
    expect(payload.htmlNotes).toContain("Surfacer produced no rationale");
  });
});

describe("heartbeat/lint/surfacer → webhook (pass-through)", () => {
  it("heartbeat: wraps output in {event, data}", () => {
    const out = { summary: "s", alerts: [] };
    expect(heartbeatToWebhook({ channelConfig: {}, agentOutput: out })).toEqual({
      event: "agent.run.completed",
      data: out,
    });
  });

  it("lint: pass-through", () => {
    const out = { findings: [{ title: "x" }] };
    expect(lintToWebhook({ channelConfig: {}, agentOutput: out })).toEqual({
      event: "agent.run.completed",
      data: out,
    });
  });

  it("surfacer: pass-through", () => {
    const out = { topic: "t" };
    expect(surfacerToWebhook({ channelConfig: {}, agentOutput: out })).toEqual({
      event: "agent.run.completed",
      data: out,
    });
  });
});

describe("generic fallbacks", () => {
  it("mergeAsanaPayloadGeneric: pretty-prints JSON in notes (NOT htmlNotes)", () => {
    const payload = mergeAsanaPayloadGeneric({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { foo: "bar", arr: [1, 2] },
    });
    expect(payload.notes).toBeDefined();
    expect(payload.htmlNotes).toBeUndefined();
    expect(payload.notes!).toContain('"foo": "bar"');
  });

  it("mergeAsanaPayloadGeneric: uses summary as title when present", () => {
    const payload = mergeAsanaPayloadGeneric({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "from-generic" },
    });
    expect(payload.title).toBe("from-generic");
  });

  it("mergeAsanaPayloadGeneric: falls back to generic label when summary missing", () => {
    const payload = mergeAsanaPayloadGeneric({
      channelConfig: CHANNEL_CONFIG,
      agentOutput: {},
    });
    expect(payload.title).toBe("opencoo daily report");
  });

  it("mergeWebhookPayloadGeneric: returns {event, data}", () => {
    const out = { random: "thing" };
    expect(
      mergeWebhookPayloadGeneric({ channelConfig: {}, agentOutput: out }),
    ).toEqual({ event: "agent.run.completed", data: out });
  });
});

describe("mergePayloadFor dispatcher", () => {
  it("routes (heartbeat, asana) to heartbeatToAsana (htmlNotes set)", () => {
    const payload = mergePayloadFor({
      agentSlug: "heartbeat",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "x", alerts: [] },
    }) as { htmlNotes?: string; notes?: string };
    expect(payload.htmlNotes).toBeDefined();
    expect(payload.notes).toBeUndefined();
  });

  it("routes (lint, asana) to lintToAsana (htmlNotes set)", () => {
    const payload = mergePayloadFor({
      agentSlug: "lint",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { findings: [] },
    }) as { htmlNotes?: string; title?: string };
    expect(payload.htmlNotes).toBeDefined();
    expect(payload.title).toMatch(/^Wiki lint findings/);
  });

  it("routes (surfacer, asana) to surfacerToAsana", () => {
    const payload = mergePayloadFor({
      agentSlug: "surfacer",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { topic: "T" },
    }) as { htmlNotes?: string; title?: string };
    expect(payload.title).toBe("T");
    expect(payload.htmlNotes).toBeDefined();
  });

  it("routes (heartbeat, webhook) to heartbeatToWebhook", () => {
    const payload = mergePayloadFor({
      agentSlug: "heartbeat",
      adapterSlug: "webhook",
      channelConfig: {},
      agentOutput: { x: 1 },
    });
    expect(payload).toEqual({ event: "agent.run.completed", data: { x: 1 } });
  });

  it("unknown-agent fallback to mergeAsanaPayloadGeneric for asana", () => {
    const payload = mergePayloadFor({
      agentSlug: "unknown-agent",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "s" },
    }) as { notes?: string; htmlNotes?: string };
    // Generic uses `notes`, NOT `htmlNotes` — that's the
    // distinguishing fingerprint of the fallback path.
    expect(payload.notes).toBeDefined();
    expect(payload.htmlNotes).toBeUndefined();
  });

  it("unknown-agent fallback to mergeWebhookPayloadGeneric for webhook", () => {
    const payload = mergePayloadFor({
      agentSlug: "unknown",
      adapterSlug: "webhook",
      channelConfig: {},
      agentOutput: { foo: 1 },
    });
    expect(payload).toEqual({
      event: "agent.run.completed",
      data: { foo: 1 },
    });
  });

  it("empty agentSlug routes to the generic fallback (not the heartbeat closure)", () => {
    // The generic fallback fingerprint is `notes` (JSON dump);
    // the agent-specific fingerprint is `htmlNotes`. An empty
    // agentSlug must NOT accidentally hit `TRANSFORMERS[""]`
    // (which is undefined) — it must traverse to the generic
    // adapter-level fallback.
    const payload = mergePayloadFor({
      agentSlug: "",
      adapterSlug: "asana",
      channelConfig: CHANNEL_CONFIG,
      agentOutput: { summary: "s" },
    }) as { notes?: string; htmlNotes?: string };
    expect(payload.notes).toBeDefined();
    expect(payload.htmlNotes).toBeUndefined();
  });

  it("throws OutputTransformerNotFoundError when neither agent-specific nor generic is registered", () => {
    expect(() =>
      mergePayloadFor({
        agentSlug: "heartbeat",
        adapterSlug: "unknown-adapter",
        channelConfig: {},
        agentOutput: {},
      }),
    ).toThrow(OutputTransformerNotFoundError);
  });
});
