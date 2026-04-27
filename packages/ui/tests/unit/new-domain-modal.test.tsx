/**
 * NewDomainModal tests — phase-a appendix #2.
 *
 * The modal opens from `+ New domain` on the Domains tab. It
 * collects (slug, class, display_name, default_locale) and
 * POSTs to /api/admin/domains. Closes the regression PR 29
 * introduced (the route shipped a list-only Domains tab).
 *
 * Pins:
 *   - Modal renders behind a backdrop (role='dialog' + aria-modal)
 *   - Esc closes
 *   - Slug client-validation regex matches the server's
 *     domains_slug_format CHECK constraint
 *   - Submit calls fetchAdmin('/api/admin/domains', POST, body)
 *   - On success the parent `onCreated` is fired with the
 *     server's response (so the parent can refetch)
 *   - On 409 slug_taken the inline error surfaces on the slug
 *     field and the modal stays open
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewDomainModal } from "../../src/components/NewDomainModal.js";

describe("NewDomainModal", () => {
  it("renders as a modal dialog (role + aria-modal)", () => {
    render(
      <NewDomainModal onCreated={() => undefined} onClose={() => undefined} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("Esc fires onClose", async () => {
    const onClose = vi.fn();
    render(
      <NewDomainModal onCreated={() => undefined} onClose={onClose} />,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("rejects an invalid slug client-side (matches server regex ^[a-z][a-z0-9-]{1,62}$)", async () => {
    const fetchImpl = vi.fn();
    const user = userEvent.setup();
    render(
      <NewDomainModal
        onCreated={() => undefined}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.type(document.querySelector("input[name='slug']")!, "Bad Slug");
    await user.type(document.querySelector("input[name='display_name']")!, "Bad");
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(fetchImpl).not.toHaveBeenCalled();
    // Inline error on the slug field surfaces the regex-mismatch
    // message — distinct from any other slug-related text.
    expect(screen.getByText(/^Slug must match/i)).toBeInTheDocument();
  });

  it("submits the right body shape on valid input", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "00000000-0000-0000-0000-000000000001",
          slug: "wiki-main",
          repoUrl: "https://gitea.test/opencoo/wiki-main",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <NewDomainModal
        onCreated={onCreated}
        onClose={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.type(document.querySelector("input[name='slug']")!, "wiki-main");
    await user.type(document.querySelector("input[name='display_name']")!, "Main wiki");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      slug: "wiki-main",
      display_name: "Main wiki",
      class: "knowledge",
      default_locale: "en",
    });
  });

  it("surfaces inline 'slug_taken' error from a 409 response and keeps the modal open", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "slug_taken", slug: "wiki-main" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <NewDomainModal
        onCreated={onCreated}
        onClose={onClose}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await user.type(document.querySelector("input[name='slug']")!, "wiki-main");
    await user.type(document.querySelector("input[name='display_name']")!, "Main");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/already (taken|used|exists)/i)).toBeInTheDocument();
    });
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
