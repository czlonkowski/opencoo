/**
 * OutputChannelDetail — Asana `assignee_gid` edit surface
 * (PR-Asana, wave-17 / phase-a appendix #17).
 *
 * Wave-14 W5 added `assignee_gid` to the Asana channel-config schema
 * and the heartbeat-to-Asana transformer reads it; what was missing
 * was an operator-facing way to edit the field after a channel was
 * provisioned. The original `OutputChannelDetail` (PR-Z4) shipped a
 * minimal Enable/Disable/Delete surface and deferred config editing
 * to v0.2 — this PR adds JUST the one field the brief calls out
 * (path-a: free-form `<input>` + tooltip, no list-users query).
 *
 * Pins:
 *   - Asana channels render an `assignee_gid` text input pre-filled
 *     from `channel.config.assignee_gid`.
 *   - Non-Asana channels (e.g. `webhook`) do NOT render the input.
 *   - The label carries a `<TooltipTrigger term="assigneeGid" />`
 *     (per the wave-16 C1 pattern). The trigger is keyboard-reachable
 *     (no tabindex override) and surfaces a `role="tooltip"` bubble
 *     when focused.
 *   - Clicking Save PATCHes `{config: { ...all-prior-fields,
 *     assignee_gid: <new value>}}` — the server's PATCH /config branch
 *     does a full jsonb replace so we must round-trip every key the
 *     channel currently carries.
 *   - When the operator clears the field, the PATCH body omits
 *     `assignee_gid` (the field is optional; emitting "" would fail
 *     the Zod schema's `.min(1)` and reject the whole save).
 *   - Save is disabled while the previous click is still in flight.
 *   - Successful save fires `onChanged()` so the parent can re-fetch.
 *
 * The tooltip text lives under `help.assigneeGid.{label,body}` in
 * the en + pl locales (added in this PR).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OutputChannelDetail } from "../../src/components/OutputChannelDetail.js";
import { ToastProvider } from "../../src/components/Toast.js";
import { setPat } from "../../src/lib/pat-store.js";
import type { OutputChannel } from "../../src/types.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function makeStubFetch(calls: FetchCall[]): typeof fetch {
  return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method, body: parsedBody });
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url.includes("/api/admin/output-channels") &&
      (method === "PATCH" || method === "DELETE")
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function asanaChannel(
  overrides: Partial<OutputChannel> = {},
): OutputChannel {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    adapterSlug: "asana",
    name: "daily-report",
    enabled: true,
    config: { project_gid: "PRJ-1" },
    createdAt: "2026-05-10T08:00:00Z",
    updatedAt: "2026-05-10T08:00:00Z",
    ...overrides,
  };
}

function renderDetail(node: JSX.Element): ReturnType<typeof render> {
  return render(<ToastProvider>{node}</ToastProvider>);
}

describe("OutputChannelDetail — Asana assignee_gid (PR-Asana, wave-17)", () => {
  it("renders an assignee_gid text input for Asana channels, pre-filled from config", () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch(calls);
    const channel = asanaChannel({
      config: { project_gid: "PRJ-1", assignee_gid: "1200900200" },
    });
    renderDetail(
      <OutputChannelDetail
        channel={channel}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: /assignee_gid/i,
    }) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("1200900200");
  });

  it("renders an empty input when the channel has no assignee_gid set yet", () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch(calls);
    renderDetail(
      <OutputChannelDetail
        channel={asanaChannel()}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: /assignee_gid/i,
    }) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("does NOT render the assignee_gid input for non-Asana (e.g. webhook) channels", () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch(calls);
    const channel = asanaChannel({
      adapterSlug: "webhook",
      config: { url: "https://example.com/hook" },
    });
    renderDetail(
      <OutputChannelDetail
        channel={channel}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: /assignee_gid/i }),
    ).toBeNull();
  });

  it("attaches a TooltipTrigger to the assignee_gid label (keyboard reachable, role=tooltip on focus)", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch(calls);
    renderDetail(
      <OutputChannelDetail
        channel={asanaChannel()}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    // The `?` button sits next to the label.
    const tooltipBtn = screen.getByRole("button", {
      name: /about assignee.gid/i,
    });
    expect(tooltipBtn).toBeTruthy();
    // No tabindex override — natural focus order keeps it reachable.
    const ti = tooltipBtn.getAttribute("tabindex");
    expect(ti === null || ti === "0").toBe(true);
    // Focusing the `?` opens the bubble.
    tooltipBtn.focus();
    fireEvent.focus(tooltipBtn);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeNull();
    });
  });

  it("PATCHes assignee_gid (merged with existing config) when Save is clicked", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch(calls);
    const channel = asanaChannel({
      config: { project_gid: "PRJ-1", title_prefix: "[COO] " },
    });
    const onChanged = vi.fn();
    renderDetail(
      <OutputChannelDetail
        channel={channel}
        onClose={(): void => {}}
        onChanged={onChanged}
        fetchImpl={stub}
      />,
    );
    const input = screen.getByRole("textbox", { name: /assignee_gid/i });
    fireEvent.change(input, { target: { value: "1200900200" } });
    fireEvent.click(screen.getByRole("button", { name: /save assignee/i }));
    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          c.url.endsWith(`/api/admin/output-channels/${channel.id}`) &&
          typeof c.body === "object" &&
          c.body !== null &&
          "config" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      // Full-config round-trip: preserve every existing field PLUS
      // the new assignee_gid value. The server's PATCH /config branch
      // does a jsonb replace, so we must send the complete shape.
      expect((patch?.body as { config: unknown }).config).toEqual({
        project_gid: "PRJ-1",
        title_prefix: "[COO] ",
        assignee_gid: "1200900200",
      });
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it("omits assignee_gid from the PATCH body when the operator clears the field", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const stub = makeStubFetch(calls);
    const channel = asanaChannel({
      config: { project_gid: "PRJ-1", assignee_gid: "old-1" },
    });
    renderDetail(
      <OutputChannelDetail
        channel={channel}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    const input = screen.getByRole("textbox", { name: /assignee_gid/i });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save assignee/i }));
    await waitFor(() => {
      const patch = calls.find(
        (c) =>
          c.method === "PATCH" &&
          typeof c.body === "object" &&
          c.body !== null &&
          "config" in (c.body as Record<string, unknown>),
      );
      expect(patch).toBeTruthy();
      // Cleared → field dropped (the Zod schema would 422 on "").
      expect((patch?.body as { config: Record<string, unknown> }).config).toEqual(
        { project_gid: "PRJ-1" },
      );
    });
  });

  it("Save button is disabled while a PATCH is in flight", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    // Slow PATCH — never resolves in the test window. Pins that the
    // button stays disabled across the round-trip so a double-click
    // can't fire two requests.
    const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      let parsedBody: unknown = undefined;
      if (typeof init?.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      calls.push({ url, method, body: parsedBody });
      if (url.includes("/api/admin/_csrf")) {
        return new Response(JSON.stringify({ csrfToken: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/admin/output-channels") && method === "PATCH") {
        await new Promise((): void => {
          /* never resolves — pin in-flight UI state */
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    renderDetail(
      <OutputChannelDetail
        channel={asanaChannel()}
        onClose={(): void => {}}
        onChanged={(): void => {}}
        fetchImpl={stub}
      />,
    );
    const input = screen.getByRole("textbox", { name: /assignee_gid/i });
    fireEvent.change(input, { target: { value: "u-1" } });
    const saveBtn = screen.getByRole("button", { name: /save assignee/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
