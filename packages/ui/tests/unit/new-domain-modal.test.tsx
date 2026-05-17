/**
 * NewDomainModal tests — phase-a appendix #2 + PR-Z9 / G12.
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
 *   - Uncontrolled inputs survive an external native-setter
 *     bypass (PR-Z9 / closes G12) — the technique 1Password +
 *     Bitwarden use to autofill fields without dispatching
 *     React-tracked keystrokes
 *   - Slug auto-fills from display-name via direct DOM write
 *     until the user explicitly edits the slug field, then
 *     stops mirroring (so user edits aren't clobbered)
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  NewDomainModal,
  slugifyDisplayName,
} from "../../src/components/NewDomainModal.js";

/**
 * Mimic password-manager autofill — set the input value via the
 * native HTMLInputElement.prototype setter (bypassing React's
 * synthetic value-tracker) and dispatch a bubbling input event.
 * This is the exact technique 1Password / Bitwarden use, and the
 * technique that triggered the G12 regression report.
 */
function externalSetValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) {
    throw new Error("HTMLInputElement value setter unavailable");
  }
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NewDomainModal", () => {
  it("renders as a modal dialog (role + aria-modal)", () => {
    render(
      <NewDomainModal onCreated={() => undefined} onClose={() => undefined} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("Esc fires onClose", async () => {
    // PR-A1 (wave-16): the Modal is a native <dialog>; the
    // browser fires a `cancel` event when the operator hits Esc.
    // jsdom does not synthesize `cancel` from keyDown, so we
    // dispatch the cancel event directly to pin the contract
    // ("Esc closes the modal" — implementation detail is that
    // it routes through cancel, not a document keydown listener).
    const onClose = vi.fn();
    render(
      <NewDomainModal onCreated={() => undefined} onClose={onClose} />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel"));
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
    // aria-invalid is set on the offending input so screen readers
    // announce the error state (preserved under the uncontrolled
    // pattern — see PR-Z9 commentary in NewDomainModal.tsx).
    expect(document.querySelector("input[name='slug']")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
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

  // ---------------------------------------------------------------
  // PR-Z9 / G12 regression suite — uncontrolled-input pattern
  // survives external native-value-setter bypasses (1Password,
  // Bitwarden, automation scripts). Pre-Z9 these tests failed
  // because controlled-input state swapped SLUG/DISPLAY-NAME on
  // the next React render.
  // ---------------------------------------------------------------

  it("preserves externally-set field values on submit (PR-Z9 / G12 regression)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "00000000-0000-0000-0000-0000000000ff",
          slug: "external-slug",
          repoUrl: "https://gitea.test/opencoo/external-slug",
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

    const slugInput = document.querySelector(
      "input[name='slug']",
    ) as HTMLInputElement;
    const nameInput = document.querySelector(
      "input[name='display_name']",
    ) as HTMLInputElement;

    // Simulate the password-manager autofill technique — exactly
    // the path that broke the controlled-input version.
    externalSetValue(slugInput, "external-slug");
    externalSetValue(nameInput, "External Name");

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // Critically: NOT swapped, NOT cleared.
    expect(body).toMatchObject({
      slug: "external-slug",
      display_name: "External Name",
    });
  });

  it("auto-fills slug from display-name when the user has not typed in slug yet", async () => {
    const user = userEvent.setup();
    render(
      <NewDomainModal
        onCreated={() => undefined}
        onClose={() => undefined}
      />,
    );

    const slugInput = document.querySelector(
      "input[name='slug']",
    ) as HTMLInputElement;
    const nameInput = document.querySelector(
      "input[name='display_name']",
    ) as HTMLInputElement;

    await user.type(nameInput, "Wiki Main");

    // Slug input was untouched, so the slugified mirror should
    // be reflected in the DOM value. The auto-fill writes via
    // the native setter (no React state round-trip).
    expect(slugInput.value).toBe("wiki-main");
  });

  it("does not overwrite a user-typed slug when display-name changes after", async () => {
    const user = userEvent.setup();
    render(
      <NewDomainModal
        onCreated={() => undefined}
        onClose={() => undefined}
      />,
    );

    const slugInput = document.querySelector(
      "input[name='slug']",
    ) as HTMLInputElement;
    const nameInput = document.querySelector(
      "input[name='display_name']",
    ) as HTMLInputElement;

    // User explicitly typed the slug first — that act flips the
    // touched flag so subsequent display-name edits stop
    // mirroring.
    await user.type(slugInput, "my-custom-slug");
    expect(slugInput.value).toBe("my-custom-slug");

    await user.type(nameInput, "Some Other Name");

    // Slug is still the user-typed value — NOT slugified
    // "some-other-name".
    expect(slugInput.value).toBe("my-custom-slug");
  });
});

// -----------------------------------------------------------------
// slugifyDisplayName — Copilot triage on PR-Z9. The server's
// domains_slug_format CHECK constraint is `^[a-z][a-z0-9-]{1,62}$`,
// so a slug must be at least 2 characters. Pre-triage,
// slugifyDisplayName("A") returned "a" — a 1-char slug that the
// auto-fill silently wrote into the input, then the server
// rejected on submit. Fix: return empty when result < 2 chars.
// -----------------------------------------------------------------

describe("slugifyDisplayName — server SLUG_REGEX minimum length", () => {
  it("returns empty when slugified result is 1 char ('A' → '')", () => {
    expect(slugifyDisplayName("A")).toBe("");
  });

  it("returns empty when stripping reduces to 1 char ('A!' → '')", () => {
    // Non-[a-z0-9] runs collapse to "-", then trailing hyphens
    // strip — "A!" → "a-" → "a". 1 char < 2, so empty.
    expect(slugifyDisplayName("A!")).toBe("");
  });

  it("returns a 2-char slug when result reaches minimum ('AB' → 'ab')", () => {
    expect(slugifyDisplayName("AB")).toBe("ab");
  });

  it("happy path still works ('My Wiki' → 'my-wiki')", () => {
    expect(slugifyDisplayName("My Wiki")).toBe("my-wiki");
  });

  it("strips diacritics via NFKD ('Áéí' → 'aei')", () => {
    // Confirms the NFKD-combining-mark strip survives the new
    // min-length guard for typical 2+ char display names. The
    // accented letters decompose to base + combining mark, then
    // the combining-mark range is stripped.
    expect(slugifyDisplayName("Áéí")).toBe("aei");
  });

  it("returns empty for inputs with no letters ('123' → '')", () => {
    // Slug regex requires `^[a-z]` — pure digits get stripped to
    // empty (was already empty pre-triage; pinned to lock the
    // contract).
    expect(slugifyDisplayName("123")).toBe("");
  });
});
