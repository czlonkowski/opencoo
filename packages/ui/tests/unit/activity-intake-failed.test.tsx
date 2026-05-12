/**
 * Activity route — `pipeline.intake_failed` SSE event rendering
 * (PR-W4, phase-a appendix #14).
 *
 * W3 made the compile-worker's failure visible in the DB. W4 publishes
 * a `pipeline.intake_failed` SSE event on each new failure so the
 * Activity feed shows operators what's breaking without a tab switch.
 *
 * Pin matrix:
 *   1. A `pipeline.intake_failed` SSE event renders a feed entry with
 *      the binding id + errorClass chip + truncated errorTextSnippet.
 *   2. Multiple events for the same (bindingId, errorClass) within an
 *      hour render the count of similar failures so the operator gets
 *      a fast "is this isolated or systemic?" signal.
 *   3. Events for different bindings or different errorClasses count
 *      separately (no cross-collapse).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { SseClient, SseListener } from "../../src/lib/sse.js";
import { Activity } from "../../src/routes/Activity.js";

// ─── Controllable SSE stub (mirrors activity-dlq.test.tsx) ─────────────────

interface SseStub extends SseClient {
  dispatch(eventType: string, data: unknown): void;
}

let currentStub: SseStub | null = null;

function makeSseStub(): SseStub {
  const listeners = new Map<string, Set<SseListener<unknown>>>();
  const stub: SseStub = {
    on<T>(eventType: string, listener: SseListener<T>): () => void {
      let set = listeners.get(eventType);
      if (set === undefined) {
        set = new Set();
        listeners.set(eventType, set);
      }
      set.add(listener as SseListener<unknown>);
      return () => {
        set?.delete(listener as SseListener<unknown>);
      };
    },
    close(): void {
      listeners.clear();
    },
    get readyState(): "open" {
      return "open";
    },
    dispatch(eventType: string, data: unknown): void {
      const set = listeners.get(eventType);
      if (set === undefined) return;
      const event = { type: eventType, data, lastEventId: "" };
      for (const listener of set) {
        listener(event);
      }
    },
  };
  currentStub = stub;
  return stub;
}

vi.mock("../../src/lib/sse.js", () => ({
  openSseClient: () => makeSseStub(),
}));

function makeFetch(): typeof fetch {
  return ((input: Parameters<typeof fetch>[0]) => {
    const url =
      input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (input as Request).url;
    if (url.includes("agent-runs")) {
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [], total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("pipelines")) {
      return Promise.resolve(
        new Response(JSON.stringify({ pipelines: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  }) as typeof fetch;
}

function makeIntakeFailedEvent(overrides?: {
  bindingId?: string;
  errorClass?: string;
  intakeId?: string;
  errorTextSnippet?: string;
  occurredAt?: string;
}) {
  return {
    bindingId: overrides?.bindingId ?? "binding-abc-001",
    errorClass: overrides?.errorClass ?? "validation",
    intakeId: overrides?.intakeId ?? "intake-1111",
    errorTextSnippet:
      overrides?.errorTextSnippet ?? "binding.allowed_paths is empty",
    occurredAt: overrides?.occurredAt ?? "2026-05-12T10:00:00.000Z",
  };
}

beforeEach(() => {
  currentStub = null;
});

describe("Activity route — pipeline.intake_failed SSE event (PR-W4)", () => {
  it("renders a feed entry with binding id + errorClass + snippet on event arrival", async () => {
    render(<Activity fetchImpl={makeFetch()} />);
    const stub = currentStub!;
    expect(stub).not.toBeNull();

    await act(() => {
      stub.dispatch("pipeline.intake_failed", makeIntakeFailedEvent());
    });

    // Binding id surfaces.
    expect(screen.getByText(/binding-abc-001/)).toBeInTheDocument();
    // Error-class chip / text surfaces.
    expect(screen.getByText(/validation/)).toBeInTheDocument();
    // Snippet surfaces (truncation is engine-side, UI just renders).
    expect(
      screen.getByText(/binding\.allowed_paths is empty/),
    ).toBeInTheDocument();
  });

  it("renders a count of similar failures within the last hour", async () => {
    render(<Activity fetchImpl={makeFetch()} />);
    const stub = currentStub!;

    // Three events for the same (binding, errorClass) inside the hour.
    const now = new Date("2026-05-12T10:30:00.000Z").toISOString();
    await act(() => {
      stub.dispatch(
        "pipeline.intake_failed",
        makeIntakeFailedEvent({
          intakeId: "intake-1",
          occurredAt: now,
        }),
      );
      stub.dispatch(
        "pipeline.intake_failed",
        makeIntakeFailedEvent({
          intakeId: "intake-2",
          occurredAt: now,
        }),
      );
      stub.dispatch(
        "pipeline.intake_failed",
        makeIntakeFailedEvent({
          intakeId: "intake-3",
          occurredAt: now,
        }),
      );
    });

    // Each event renders its own row with its own counter (rolling
    // window count at the time of that event). The most-recent
    // entry (first in the feed, prepended) sees the full count of 3.
    const counters = screen.getAllByTestId(
      "intake-failed-count-binding-abc-001-validation",
    );
    expect(counters.length).toBe(3);
    // Feed prepends new entries → the freshest counter is the first
    // element in the queried list, carrying the full rolling count.
    expect(counters[0]!.textContent).toMatch(/\b3\b/);
  });

  it("does not collapse across different bindings or errorClasses", async () => {
    render(<Activity fetchImpl={makeFetch()} />);
    const stub = currentStub!;

    await act(() => {
      stub.dispatch(
        "pipeline.intake_failed",
        makeIntakeFailedEvent({
          bindingId: "binding-A",
          errorClass: "validation",
          intakeId: "intake-A1",
        }),
      );
      stub.dispatch(
        "pipeline.intake_failed",
        makeIntakeFailedEvent({
          bindingId: "binding-B",
          errorClass: "validation",
          intakeId: "intake-B1",
        }),
      );
      stub.dispatch(
        "pipeline.intake_failed",
        makeIntakeFailedEvent({
          bindingId: "binding-A",
          errorClass: "transient",
          intakeId: "intake-A2",
        }),
      );
    });

    // Each (bindingId, errorClass) pair gets its own counter, each at 1.
    const a_val = screen.getByTestId("intake-failed-count-binding-A-validation");
    const b_val = screen.getByTestId("intake-failed-count-binding-B-validation");
    const a_tra = screen.getByTestId("intake-failed-count-binding-A-transient");
    expect(a_val.textContent).toMatch(/\b1\b/);
    expect(b_val.textContent).toMatch(/\b1\b/);
    expect(a_tra.textContent).toMatch(/\b1\b/);
  });
});
