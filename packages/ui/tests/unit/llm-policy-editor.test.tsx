/**
 * LlmPolicyEditor tests — PR-Q13, phase-a appendix #9.
 *
 * The editor replaces the raw-JSON textarea on the LLM-policy
 * tab with a tier-by-tier dropdown (provider + model) backed
 * by the static catalog served at GET /api/admin/llm-models.
 *
 * Pins:
 *  - Three tiers (Thinker / Worker / Light) each render a
 *    provider <select> + a model <select>.
 *  - Picking a provider repopulates the model dropdown from
 *    `MODEL_CATALOG[provider]`.
 *  - Ollama (empty catalog) swaps the dropdown for a
 *    custom-input field.
 *  - OpenRouter renders the dropdown PLUS an "Other model…"
 *    sentinel that swaps to a custom-input field.
 *  - `local_only` checkbox toggles the boolean cleanly.
 *  - The advanced raw-JSON view round-trips dropdown ↔ JSON
 *    (no value loss, no cross-tier bleed).
 *  - The serialised value matches the prior textarea shape so
 *    the existing preview/apply flow stays unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  LlmPolicyEditor,
  type LlmPolicyValue,
} from "../../src/components/LlmPolicyEditor.js";

const CATALOG_RESPONSE = {
  catalog: {
    openai: ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "gpt-4-turbo"],
    anthropic: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-3-5-sonnet-20241022",
    ],
    google: [
      "gemini-2.0-flash",
      "gemini-2.0-flash-thinking",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    ollama: [],
    openrouter: [
      "moonshotai/kimi-k2.6",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-opus-4-7",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
      "deepseek/deepseek-r1",
    ],
  },
};

function makeFetchMock(): { fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/admin/llm-models") {
      return new Response(JSON.stringify(CATALOG_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl };
}

describe("LlmPolicyEditor", () => {
  it("renders three tiers with provider + model dropdowns", async () => {
    const { fetchImpl } = makeFetchMock();
    const onChange = vi.fn();
    render(
      <LlmPolicyEditor
        value={{}}
        onChange={onChange}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='thinker.provider']"),
      ).not.toBeNull();
    });
    for (const tier of ["thinker", "worker", "light"]) {
      expect(
        document.querySelector(`select[name='${tier}.provider']`),
      ).not.toBeNull();
      expect(
        document.querySelector(`select[name='${tier}.model']`),
      ).not.toBeNull();
    }
  });

  it("model dropdown loads from catalog for the selected provider", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    render(
      <LlmPolicyEditor
        value={{}}
        onChange={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='thinker.provider']"),
      ).not.toBeNull();
    });
    // Pick anthropic for the Thinker tier.
    await user.selectOptions(
      document.querySelector("select[name='thinker.provider']")!,
      "anthropic",
    );
    const modelSelect = document.querySelector(
      "select[name='thinker.model']",
    ) as HTMLSelectElement;
    const modelValues = Array.from(modelSelect.options).map((o) => o.value);
    expect(modelValues).toContain("claude-opus-4-7");
    expect(modelValues).toContain("claude-sonnet-4-6");
  });

  it("emits the canonical policy shape via onChange (matches prior textarea body)", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LlmPolicyEditor
        value={{}}
        onChange={onChange}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='thinker.provider']"),
      ).not.toBeNull();
    });
    await user.selectOptions(
      document.querySelector("select[name='thinker.provider']")!,
      "openrouter",
    );
    await user.selectOptions(
      document.querySelector("select[name='thinker.model']")!,
      "moonshotai/kimi-k2.6",
    );
    // Last onChange call carries the round-tripped shape.
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last["thinker"]).toEqual({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("ollama tier swaps the dropdown for a custom-input field", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LlmPolicyEditor
        value={{}}
        onChange={onChange}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='thinker.provider']"),
      ).not.toBeNull();
    });
    await user.selectOptions(
      document.querySelector("select[name='thinker.provider']")!,
      "ollama",
    );
    // Dropdown is replaced by a custom-input field.
    expect(document.querySelector("select[name='thinker.model']")).toBeNull();
    const input = document.querySelector(
      "input[name='thinker.model']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await user.type(input, "llama3.2:8b");
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last["thinker"]).toEqual({
      provider: "ollama",
      model: "llama3.2:8b",
    });
  });

  it("openrouter offers an 'Other model…' fallback that swaps to a custom-input field", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LlmPolicyEditor
        value={{}}
        onChange={onChange}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='thinker.provider']"),
      ).not.toBeNull();
    });
    await user.selectOptions(
      document.querySelector("select[name='thinker.provider']")!,
      "openrouter",
    );
    // The dropdown carries the sentinel option.
    const modelSelect = document.querySelector(
      "select[name='thinker.model']",
    ) as HTMLSelectElement;
    const optValues = Array.from(modelSelect.options).map((o) => o.value);
    expect(optValues).toContain("__custom__");
    // Picking the sentinel swaps in the custom-input field.
    await user.selectOptions(modelSelect, "__custom__");
    const input = document.querySelector(
      "input[name='thinker.model']",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await user.type(input, "qwen/qwen-2.5-72b-instruct");
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last["thinker"]).toEqual({
      provider: "openrouter",
      model: "qwen/qwen-2.5-72b-instruct",
    });
  });

  it("local_only toggle round-trips through the boolean checkbox", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LlmPolicyEditor
        value={{ local_only: false }}
        onChange={onChange}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("input[name='local_only']"),
      ).not.toBeNull();
    });
    const checkbox = document.querySelector(
      "input[name='local_only']",
    ) as HTMLInputElement;
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last["local_only"]).toBe(true);
  });

  it("seeds the dropdowns from the incoming `value` prop", async () => {
    const { fetchImpl } = makeFetchMock();
    render(
      <LlmPolicyEditor
        value={{
          thinker: { provider: "anthropic", model: "claude-opus-4-7" },
          worker: { provider: "openai", model: "gpt-4o-mini" },
          light: { provider: "openai", model: "gpt-4o-mini" },
          local_only: true,
        }}
        onChange={() => undefined}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='thinker.provider']"),
      ).not.toBeNull();
    });
    expect(
      (document.querySelector(
        "select[name='thinker.provider']",
      ) as HTMLSelectElement).value,
    ).toBe("anthropic");
    expect(
      (document.querySelector(
        "select[name='thinker.model']",
      ) as HTMLSelectElement).value,
    ).toBe("claude-opus-4-7");
    expect(
      (document.querySelector(
        "input[name='local_only']",
      ) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("advanced raw-JSON view round-trips dropdown state ↔ JSON", async () => {
    const { fetchImpl } = makeFetchMock();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LlmPolicyEditor
        value={{
          thinker: { provider: "anthropic", model: "claude-opus-4-7" },
          worker: { provider: "openai", model: "gpt-4o-mini" },
          light: { provider: "openai", model: "gpt-4o-mini" },
          local_only: false,
        }}
        onChange={onChange}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector("select[name='thinker.provider']"),
      ).not.toBeNull();
    });
    // The advanced toggle is collapsed by default; expand it.
    await user.click(
      document.querySelector(
        "button[data-testid='advanced-toggle']",
      ) as HTMLButtonElement,
    );
    const textarea = document.querySelector(
      "textarea[name='raw-json']",
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    // Dropdown state is reflected in the JSON view.
    const seenJson = JSON.parse(textarea.value) as Record<string, unknown>;
    expect(seenJson["thinker"]).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(seenJson["local_only"]).toBe(false);

    // Edit the JSON: change Thinker provider to openrouter +
    // model to moonshotai/kimi-k2.6.
    const edited = {
      thinker: { provider: "openrouter", model: "moonshotai/kimi-k2.6" },
      worker: { provider: "openai", model: "gpt-4o-mini" },
      light: { provider: "openai", model: "gpt-4o-mini" },
      local_only: true,
    };
    await user.clear(textarea);
    // `userEvent.type` parses `{` / `[` as keyboard descriptors;
    // `paste` puts the literal string in unmolested. The runtime
    // path (browser paste / textarea autofill) hits the same
    // onChange handler.
    await user.click(textarea);
    await user.paste(JSON.stringify(edited));
    // The dropdown state reflects the edited JSON.
    await waitFor(() => {
      const provSelect = document.querySelector(
        "select[name='thinker.provider']",
      ) as HTMLSelectElement;
      expect(provSelect.value).toBe("openrouter");
    });
    expect(
      (document.querySelector(
        "select[name='thinker.model']",
      ) as HTMLSelectElement).value,
    ).toBe("moonshotai/kimi-k2.6");
    expect(
      (document.querySelector(
        "input[name='local_only']",
      ) as HTMLInputElement).checked,
    ).toBe(true);
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last["thinker"]).toEqual({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
    });
  });

  it("preserves unknown extra keys on round-trip (Copilot triage / v0.2 forward-compat)", async () => {
    // PR-Q13 documented "Pass-through of unknown extra keys preserves
    // v0.2 future-shape compatibility." The reviewer flagged this
    // as untested. Pass an unknown top-level field, mutate one tier
    // through the dropdowns, and assert the unknown field survives
    // verbatim on the next emitted onChange.
    const onChange = vi.fn();
    // v0.2-shaped extras are typed via the `[k: string]: unknown`
    // index signature on `LlmPolicyValue`. Cast through `as const`
    // so the literal `provider: "openai"` narrows to ProviderName.
    const value: LlmPolicyValue = {
      thinker: { provider: "openai", model: "gpt-4o" },
      worker: { provider: "openai", model: "gpt-4o-mini" },
      light: { provider: "openai", model: "gpt-4o-mini" },
      local_only: false,
      // v0.2-shaped extra key the editor doesn't know about. The
      // editor MUST round-trip this as-is; otherwise a one-tier
      // dropdown change silently drops server-pushed v0.2 state.
      v0_2_priority_routing: {
        sticky_session_id: "abc-123",
        max_tokens_override: 4096,
      },
      another_unknown: "preserve me",
    } as const satisfies LlmPolicyValue;
    const user = userEvent.setup();
    render(<LlmPolicyEditor value={value} onChange={onChange} />);

    // Mutate one tier — pick a different anthropic model — to
    // trigger a fresh `onChange`.
    const provSelect = document.querySelector(
      "select[name='worker.provider']",
    ) as HTMLSelectElement;
    await user.selectOptions(provSelect, "anthropic");
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    expect(last["worker"]).toEqual({
      provider: "anthropic",
      // Provider-switch clears `model` until the operator picks
      // one from the new catalog (intentional — picking a Claude
      // model when the operator selected Anthropic is the human's
      // call). The unknown-extras pass-through is what we're
      // pinning here; the worker.model state is incidental.
      model: "",
    });
    // Unknown extras MUST survive verbatim.
    expect(last["v0_2_priority_routing"]).toEqual({
      sticky_session_id: "abc-123",
      max_tokens_override: 4096,
    });
    expect(last["another_unknown"]).toBe("preserve me");
  });

  it("renders a stale model as an '(unknown)' option without dropping it (Copilot triage)", () => {
    // Drift case: the persisted policy has a model that is no longer
    // in the current catalog (catalog was trimmed, or the value came
    // from a v0.2 server pin). The dropdown's `value` MUST match an
    // actual `<option>` so React doesn't silently coerce to the
    // first option. Render an explicit "(unknown)" option marked
    // `value={state.model}` to keep the displayed value and the
    // emitted state in sync.
    const onChange = vi.fn();
    const value: LlmPolicyValue = {
      thinker: { provider: "openai", model: "gpt-3.5-legacy-not-in-catalog" },
      worker: { provider: "openai", model: "gpt-4o" },
      light: { provider: "openai", model: "gpt-4o-mini" },
      local_only: false,
    } as const satisfies LlmPolicyValue;
    render(<LlmPolicyEditor value={value} onChange={onChange} />);

    const sel = document.querySelector(
      "select[name='thinker.model']",
    ) as HTMLSelectElement;
    expect(sel.value).toBe("gpt-3.5-legacy-not-in-catalog");
    // The fallback option is rendered with the literal model id and
    // an "(unknown)" suffix.
    const opts = Array.from(sel.options).map((o) => o.text);
    expect(opts).toContain("gpt-3.5-legacy-not-in-catalog (unknown)");
  });
});
