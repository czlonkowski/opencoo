/**
 * Sources route — status column enrichment (phase-a appendix #4 PR-A).
 *
 * Tests the new server-side status rendering:
 *   - name column shows human-readable label (not UUID)
 *   - status column shows server-provided status (healthy / advisory /
 *     alert / null) instead of the old client-side b.enabled derivation
 *   - lastEventAt renders as a relative time string
 *   - lastError is shown when present
 *   - null status (new/paused binding) renders neutral
 *   - all three non-null states (healthy, advisory, alert) are rendered
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { Sources } from "../../src/routes/Sources.js";

/** Build a mock SourceBinding with the new fields. */
function makeBinding(overrides: {
  id?: string;
  domainSlug?: string;
  adapterSlug?: string;
  reviewMode?: string;
  enabled?: boolean;
  notes?: string | null;
  name?: string;
  status?: "healthy" | "advisory" | "alert" | null;
  lastEventAt?: string | null;
  lastError?: string | null;
}) {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    domainSlug: overrides.domainSlug ?? "wiki-test",
    adapterSlug: overrides.adapterSlug ?? "drive",
    reviewMode: overrides.reviewMode ?? "auto",
    enabled: overrides.enabled ?? true,
    notes: overrides.notes ?? null,
    name: overrides.name ?? "drive → wiki-test",
    status: overrides.status ?? null,
    lastEventAt: overrides.lastEventAt ?? null,
    lastError: overrides.lastError ?? null,
  };
}

function makeFetchWithBindings(
  bindings: ReturnType<typeof makeBinding>[],
): typeof fetch {
  return vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/admin/source-bindings") {
      return new Response(JSON.stringify({ rows: bindings }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("404", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Sources route — name column", () => {
  it("renders the name field (not the UUID) in the binding column", async () => {
    const binding = makeBinding({ name: "My Asana binding" });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("My Asana binding"));
    expect(screen.getByText("My Asana binding")).toBeInTheDocument();
    // UUID should NOT appear as the display name
    expect(screen.queryByText(binding.id)).not.toBeInTheDocument();
  });

  it("renders adapter → domain name when notes is null", async () => {
    const binding = makeBinding({ name: "drive → wiki-ops", notes: null });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("drive → wiki-ops"));
    expect(screen.getByText("drive → wiki-ops")).toBeInTheDocument();
  });
});

describe("Sources route — status badge (server-side)", () => {
  it("renders 'healthy' badge for a healthy binding", async () => {
    const binding = makeBinding({
      status: "healthy",
      lastEventAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() =>
      expect(
        screen.getByText(/healthy/i),
      ).toBeInTheDocument(),
    );
  });

  it("renders 'advisory' badge for an advisory binding", async () => {
    const binding = makeBinding({
      status: "advisory",
      lastEventAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
    });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() =>
      expect(
        screen.getByText(/advisory/i),
      ).toBeInTheDocument(),
    );
  });

  it("renders 'alert' badge for an alert binding", async () => {
    const binding = makeBinding({
      status: "alert",
      lastEventAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      lastError: "transient",
    });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() =>
      expect(
        screen.getByText(/alert/i),
      ).toBeInTheDocument(),
    );
  });

  it("renders neutral (no status badge text) for a null-status binding", async () => {
    const binding = makeBinding({ status: null, lastEventAt: null, enabled: true });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    // Wait for the row to actually render before asserting absence of badge text.
    await screen.findByText(binding.name);
    // No status-related text for neutral state
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/advisory/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/alert/i)).not.toBeInTheDocument();
  });

  it("does NOT render a client-side derived 'ok' / 'paused' status", async () => {
    // This is the regression test for the old client-side derivation
    // (Sources.tsx line 87 pre-PR-A: `b.enabled ? "ok" : "paused"`).
    // After this PR, the UI reads from server-provided `status` field.
    const binding = makeBinding({ status: "healthy", enabled: true });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText(/healthy/i));
    // "ok" and "paused" are old client-side labels — must not appear now
    expect(screen.queryByText(/^ok$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^paused$/i)).not.toBeInTheDocument();
  });
});

describe("Sources route — lastEventAt column", () => {
  it("renders relative time for a recent lastEventAt", async () => {
    const binding = makeBinding({
      status: "healthy",
      lastEventAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), // 2h ago
    });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() =>
      expect(screen.getByText(/2h ago|2 hours? ago/i)).toBeInTheDocument(),
    );
  });

  it("renders an empty/dash cell when lastEventAt is null", async () => {
    const binding = makeBinding({ status: null, lastEventAt: null });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    // Wait for the row to render before asserting cell content.
    await screen.findByText(binding.name);
    // Should not throw; cell renders without crashing
    expect(screen.queryByText(/NaN|Invalid/i)).not.toBeInTheDocument();
  });
});

describe("Sources route — lastError column", () => {
  it("renders lastError when present", async () => {
    const binding = makeBinding({
      status: "alert",
      lastError: "transient",
    });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    await waitFor(() => screen.getByText("transient"));
    expect(screen.getByText("transient")).toBeInTheDocument();
  });

  it("renders empty when lastError is null", async () => {
    const binding = makeBinding({ status: "healthy", lastError: null });
    const fetchImpl = makeFetchWithBindings([binding]);
    render(<Sources fetchImpl={fetchImpl} />);

    // Wait for the row to render before asserting absence of error text.
    await screen.findByText(binding.name);
    // No error text shown
    expect(screen.queryByText(/null|undefined/i)).not.toBeInTheDocument();
  });
});
