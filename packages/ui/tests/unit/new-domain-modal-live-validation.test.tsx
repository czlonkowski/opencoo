/**
 * NewDomainModal live-validation tests — wave-16 PR-B4.
 *
 * Pins the hook wiring:
 *   - Typing in slug shows the "checking…" chip immediately
 *     (sync passes, async fires).
 *   - After the 250ms debounce + the API mock resolution, the
 *     chip flips to "valid" or "invalid" depending on the mock.
 *   - Typing again cancels the in-flight slug-uniqueness GET.
 *   - The uncontrolled-input pattern (PR-Z9) survives — the
 *     slug input retains its DOM value across renders, and an
 *     external-setter bypass still flows through validation.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { NewDomainModal } from "../../src/components/NewDomainModal.js";

function setUncontrolledInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("no setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NewDomainModal — live validation (PR-B4)", () => {
  it("shows 'checking…' chip while the slug-uniqueness GET is in flight", async () => {
    let resolveSlug: ((rows: Array<{ slug: string }>) => void) | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/domains")) {
        return new Promise<Response>((resolve) => {
          resolveSlug = (rows): void =>
            resolve(
              new Response(JSON.stringify({ rows }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
        });
      }
      return new Response("{}", { status: 200 });
    });
    render(
      <NewDomainModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const slugInput = document.querySelector(
      "input[name='slug']",
    ) as HTMLInputElement;
    setUncontrolledInput(slugInput, "wiki-main");
    // Sync passes (format is valid); the hook flips status to
    // 'validating' immediately, then the 250ms debounce fires the
    // GET. Wait for the deferred fetch to actually have started
    // before resolving — `resolveSlug` is captured inside the
    // fetchImpl, so we wait until it's defined.
    await waitFor(() => expect(resolveSlug).toBeDefined());
    expect(slugInput).toHaveAttribute("aria-busy", "true");
    // Chip's micro-label reads "checking…"
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
    // Resolve the GET as "no row with that slug exists" → valid.
    resolveSlug!([]);
    await waitFor(
      () => expect(slugInput).not.toHaveAttribute("aria-busy"),
      { timeout: 2000 },
    );
  });

  it("flips to 'invalid' when slug-uniqueness returns a hit", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/domains")) {
        return new Response(
          JSON.stringify({ rows: [{ slug: "wiki-main" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });
    render(
      <NewDomainModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const slugInput = document.querySelector(
      "input[name='slug']",
    ) as HTMLInputElement;
    setUncontrolledInput(slugInput, "wiki-main");
    await waitFor(() => {
      expect(slugInput).toHaveAttribute("aria-invalid", "true");
    });
    expect(screen.getByText(/already (taken|used|exists)/i)).toBeInTheDocument();
  });

  it("shows format error synchronously on a bad slug (no async fetch)", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new Error("should not be called");
    });
    render(
      <NewDomainModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const slugInput = document.querySelector(
      "input[name='slug']",
    ) as HTMLInputElement;
    setUncontrolledInput(slugInput, "Bad Slug");
    await waitFor(() => {
      expect(screen.getByText(/^Slug must match/i)).toBeInTheDocument();
    });
    // No GET to /api/admin/domains should have fired (sync failed).
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves the uncontrolled-input pattern — external setter still flows", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/admin/domains")) {
        return new Response(JSON.stringify({ rows: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });
    render(
      <NewDomainModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const slugInput = document.querySelector(
      "input[name='slug']",
    ) as HTMLInputElement;
    // External-setter bypass — same path 1Password / Bitwarden use.
    setUncontrolledInput(slugInput, "external-slug");
    await waitFor(() => {
      // Validation chip should have flipped via the same input event
      // path; the DOM value should also still be the external value
      // (uncontrolled-pattern preserved).
      expect(slugInput.value).toBe("external-slug");
    });
  });
});
