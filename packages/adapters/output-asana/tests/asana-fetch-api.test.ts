/**
 * Asana fetch-API tests (PR-W5, phase-a appendix #14).
 *
 * Covers the createTask POST body shape — specifically the
 * `sectionGid` → `memberships: [{ project, section }]` path
 * added in W5.
 *
 * The fetch wrapper takes an `fetchImpl` test seam; the tests
 * inject a stub that captures the request body, asserts the
 * shape, and returns a synthetic 201 envelope.
 *
 * THREAT-MODEL §3.6 invariant 11: no test asserts on the access
 * token in error messages — the wrapper never logs the token
 * even when 4xx surfaces.
 */
import { describe, expect, it } from "vitest";

import { createAsanaFetchApi } from "../src/asana-fetch-api.js";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeStubFetch(opts: {
  readonly captures: CapturedRequest[];
  readonly responseJson?: unknown;
}): typeof fetch {
  const responseJson = opts.responseJson ?? {
    data: {
      gid: "asana-task-1",
      permalink_url: "https://app.asana.com/0/0/asana-task-1",
    },
  };
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const bodyStr =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyStr) as Record<string, unknown>;
    } catch {
      body = {};
    }
    opts.captures.push({ url, method, body });
    return Promise.resolve(
      new Response(JSON.stringify(responseJson), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

describe("createAsanaFetchApi — createTask body shape", () => {
  it("default (no sectionGid): body uses `projects: [projectGid]` (no memberships)", async () => {
    const captures: CapturedRequest[] = [];
    const api = createAsanaFetchApi({ fetchImpl: makeStubFetch({ captures }) });
    await api.createTask({
      accessToken: Buffer.from("pat"),
      projectGid: "p-1",
      title: "T",
      notes: "n",
    });
    expect(captures).toHaveLength(1);
    const data = captures[0]!.body.data as Record<string, unknown>;
    expect(data.projects).toEqual(["p-1"]);
    expect(data.memberships).toBeUndefined();
  });

  it("PR-W5: with sectionGid sends `memberships: [{ project, section }]` (no `projects` field)", async () => {
    const captures: CapturedRequest[] = [];
    const api = createAsanaFetchApi({ fetchImpl: makeStubFetch({ captures }) });
    await api.createTask({
      accessToken: Buffer.from("pat"),
      projectGid: "p-1",
      sectionGid: "sec-42",
      title: "T",
      notes: "n",
    });
    expect(captures).toHaveLength(1);
    const data = captures[0]!.body.data as Record<string, unknown>;
    expect(data.memberships).toEqual([{ project: "p-1", section: "sec-42" }]);
    // When memberships is set the bare `projects` field must NOT
    // also appear — Asana's REST API treats them as alternatives.
    expect(data.projects).toBeUndefined();
  });

  it("PR-W5: sectionGid path still forwards dueOn + assigneeGid + notes/html_notes correctly", async () => {
    const captures: CapturedRequest[] = [];
    const api = createAsanaFetchApi({ fetchImpl: makeStubFetch({ captures }) });
    await api.createTask({
      accessToken: Buffer.from("pat"),
      projectGid: "p-1",
      sectionGid: "sec-9",
      title: "T",
      htmlNotes: "<body><h1>x</h1></body>",
      dueOn: "2026-05-13",
      assigneeGid: "u-7",
    });
    const data = captures[0]!.body.data as Record<string, unknown>;
    expect(data.memberships).toEqual([{ project: "p-1", section: "sec-9" }]);
    expect(data.html_notes).toBe("<body><h1>x</h1></body>");
    expect(data.due_on).toBe("2026-05-13");
    expect(data.assignee).toBe("u-7");
    expect(data.notes).toBeUndefined();
  });

  it("POSTs to the /tasks endpoint with bearer auth header", async () => {
    const captures: CapturedRequest[] = [];
    const headerCapture: { value: string | null } = { value: null };
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      headerCapture.value =
        headers?.authorization ?? headers?.Authorization ?? null;
      captures.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        body: JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { gid: "asana-task-1" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    const api = createAsanaFetchApi({ fetchImpl });
    await api.createTask({
      accessToken: Buffer.from("the-token"),
      projectGid: "p-1",
      title: "T",
      notes: "n",
    });
    expect(captures[0]!.method).toBe("POST");
    expect(captures[0]!.url).toContain("/tasks");
    expect(headerCapture.value).toBe("Bearer the-token");
  });
});
