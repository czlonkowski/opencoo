/**
 * SchedulerEditor — cadence picker + custom-cron preview (PR-R6,
 * phase-a appendix #10).
 *
 * Pin matrix:
 *   1. Cadence picker → cron round-trip — picking
 *      "every weekday at HH:MM" emits the cron string `M H * * 1-5`
 *      to the PUT body.
 *   2. Custom-cron next-5-fires — typing `0 0 1 * *` (first of
 *      month) renders 5 future ISO strings whose day-of-month is 1.
 *   3. Invalid cron — friendly inline error AND Save button
 *      disabled.
 *   4. Schedule-applied feedback — after a 200 response, the
 *      "Schedule updated" text appears.
 *   5. Cancel — clicking Cancel calls the parent's onCancel.
 *
 * The tests render the editor in isolation (the Activity-tab
 * integration is covered by the route-level test in
 * `activity.test.tsx`). The fetch impl is stubbed so we can
 * assert on the body sent to the PUT verb.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SchedulerEditor } from "../../src/components/SchedulerEditor.js";
import { setPat } from "../../src/lib/pat-store.js";

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function makeStubFetch(opts: {
  readonly status?: number;
  readonly responseBody?: unknown;
  readonly calls?: FetchCall[];
}): typeof fetch {
  const calls = opts.calls ?? [];
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
    if (url.includes("/api/admin/scheduler/")) {
      calls.push({ url, method, body: parsedBody });
      return new Response(
        JSON.stringify(
          opts.responseBody ?? {
            agent: "lint",
            cron: "0 9 * * 1-5",
            instanceCount: 1,
            nextFires: [],
          },
        ),
        {
          status: opts.status ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.includes("/api/admin/_csrf")) {
      return new Response(JSON.stringify({ csrfToken: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("SchedulerEditor — cadence picker round-trip", () => {
  it("posts the right cron when 'every weekday' + 09:00 is picked", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const fetchStub = makeStubFetch({ calls });
    const onApplied = vi.fn();
    const onCancel = vi.fn();
    render(
      <SchedulerEditor
        agentSlug="lint"
        currentCron="0 3 * * 0"
        onApplied={onApplied}
        onCancel={onCancel}
        fetchImpl={fetchStub}
      />,
    );
    // Pick the weekday preset.
    const presetSelect = screen.getByLabelText(/cadence/i);
    fireEvent.change(presetSelect, { target: { value: "weekday" } });

    // Hour input — set to 09; minute already 00 from the
    // detectPreset fallback (the seed cron `0 3 * * 0` resolves
    // to preset=sunday, hour=03, minute=00; switching to weekday
    // keeps minute=00, sets hour=03 → we re-set to 09 explicitly).
    const hourInput = screen.getByLabelText("hour");
    fireEvent.change(hourInput, { target: { value: "9" } });

    // The cron echo reflects the picker state.
    const echo = screen.getByTestId("scheduler-editor-cron-echo");
    expect(echo.textContent).toBe("0 9 * * 1-5");

    // Save.
    const saveBtn = screen.getByTestId("scheduler-editor-save");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(calls.length).toBe(1);
    });
    expect(calls[0]!.url).toContain("/api/admin/scheduler/lint");
    expect(calls[0]!.method).toBe("PUT");
    expect((calls[0]!.body as { cron: string }).cron).toBe("0 9 * * 1-5");

    // onApplied called after the successful response.
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledTimes(1);
    });
  });
});

describe("SchedulerEditor — custom cron next-5-fires preview", () => {
  it("renders 5 first-of-the-month ISO strings for `0 0 1 * *`", async () => {
    setPat("test-pat");
    const fetchStub = makeStubFetch({});
    render(
      <SchedulerEditor
        agentSlug="heartbeat"
        currentCron="0 8 * * 1-5"
        onApplied={vi.fn()}
        onCancel={vi.fn()}
        fetchImpl={fetchStub}
      />,
    );

    // Switch to custom mode.
    const presetSelect = screen.getByLabelText(/cadence/i);
    fireEvent.change(presetSelect, { target: { value: "custom" } });

    // Type `0 0 1 * *`.
    const cronInput = screen.getByTestId("scheduler-editor-cron-input");
    fireEvent.change(cronInput, { target: { value: "0 0 1 * *" } });

    const preview = await screen.findByTestId("scheduler-editor-next-fires");
    // 1 header line + 5 ISO entries.
    const isoLines = preview.querySelectorAll("div");
    // First child is the "NEXT 5 FIRES" header div, subsequent
    // are the 5 ISO entries.
    const isos = Array.from(isoLines)
      .slice(1) // drop the header
      .map((el) => el.textContent ?? "");
    expect(isos).toHaveLength(5);
    for (const iso of isos) {
      const d = new Date(iso);
      expect(d.toString()).not.toBe("Invalid Date");
      // Day-of-month is 1 (UTC) for every entry — first-of-month
      // is exactly what `0 0 1 * *` schedules.
      expect(d.getUTCDate()).toBe(1);
    }
  });
});

describe("SchedulerEditor — invalid cron disables Save", () => {
  it("renders an inline error AND disables the Save button", async () => {
    setPat("test-pat");
    const calls: FetchCall[] = [];
    const fetchStub = makeStubFetch({ calls });
    render(
      <SchedulerEditor
        agentSlug="lint"
        currentCron="0 3 * * 0"
        onApplied={vi.fn()}
        onCancel={vi.fn()}
        fetchImpl={fetchStub}
      />,
    );
    const presetSelect = screen.getByLabelText(/cadence/i);
    fireEvent.change(presetSelect, { target: { value: "custom" } });
    const cronInput = screen.getByTestId("scheduler-editor-cron-input");
    fireEvent.change(cronInput, { target: { value: "definitely not a cron" } });

    // Inline error visible.
    await screen.findByTestId("scheduler-editor-error");

    // Save button disabled.
    const saveBtn = screen.getByTestId("scheduler-editor-save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Even if we click, the fetch is not invoked.
    fireEvent.click(saveBtn);
    expect(calls.length).toBe(0);
  });
});

describe("SchedulerEditor — applied feedback", () => {
  it("shows 'Schedule updated' after a successful PUT", async () => {
    setPat("test-pat");
    const fetchStub = makeStubFetch({ status: 200 });
    render(
      <SchedulerEditor
        agentSlug="surfacer"
        currentCron="0 4 * * 1"
        onApplied={vi.fn()}
        onCancel={vi.fn()}
        fetchImpl={fetchStub}
      />,
    );
    // Default-detect lands on preset=custom for `0 4 * * 1` (no
    // matching preset). Hit Save directly.
    const saveBtn = screen.getByTestId("scheduler-editor-save");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("scheduler-editor-applied")).not.toBeNull();
    });
    expect(
      screen.getByTestId("scheduler-editor-applied").textContent,
    ).toMatch(/Schedule updated|Harmonogram zaktualizowany/);
  });
});

describe("SchedulerEditor — cancel", () => {
  it("invokes onCancel when the operator clicks Cancel", () => {
    setPat("test-pat");
    const onCancel = vi.fn();
    render(
      <SchedulerEditor
        agentSlug="lint"
        currentCron="0 3 * * 0"
        onApplied={vi.fn()}
        onCancel={onCancel}
        fetchImpl={makeStubFetch({})}
      />,
    );
    const cancelBtn = screen.getByTestId("scheduler-editor-cancel");
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
