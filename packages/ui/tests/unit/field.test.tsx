/**
 * Field tests — type-level discriminated-union assertions plus
 * a thin runtime smoke for both modes.
 *
 * The interesting safety property lives at the *type* level: a
 * caller who passes only `value` (without `onChange`) — or only
 * `onChange` (without `value`) — should NOT compile. Pre-Copilot-
 * triage, the two were independently optional and a half-
 * controlled input would silently ignore the unpaired prop. The
 * `@ts-expect-error` lines below pin that regression: if either
 * line ever stops being an error (i.e. the union loosens back
 * into independently-optional fields), `tsc --noEmit` will fail
 * the build with "Unused @ts-expect-error directive".
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Field } from "../../src/components/Field.js";

describe("Field — type-level half-controlled rejection", () => {
  it("rejects value-without-onChange at the type level", () => {
    const HalfControlledA = (): JSX.Element => (
      // @ts-expect-error — passing only `value` without `onChange`
      // is a half-controlled input. The discriminated union refuses.
      <Field name="x" label="X" value="hello" />
    );
    // The runtime render is irrelevant — the assertion is the
    // ts-expect-error above. We still touch the binding so the
    // unused-vars rule doesn't strip it.
    expect(typeof HalfControlledA).toBe("function");
  });

  it("rejects onChange-without-value at the type level", () => {
    const HalfControlledB = (): JSX.Element => (
      // @ts-expect-error — passing only `onChange` without `value`
      // is the mirror case; also a half-controlled input. The
      // discriminated union refuses.
      <Field name="x" label="X" onChange={() => undefined} />
    );
    expect(typeof HalfControlledB).toBe("function");
  });

  it("rejects mixing controlled + uncontrolled props", () => {
    const ref = createRef<HTMLInputElement>();
    const Mixed = (): JSX.Element => (
      // @ts-expect-error — cannot pass `inputRef` (uncontrolled
      // mode) alongside `value` + `onChange` (controlled mode).
      // The two modes are mutually exclusive at the type level.
      <Field
        name="x"
        label="X"
        value="hello"
        onChange={() => undefined}
        inputRef={ref}
      />
    );
    expect(typeof Mixed).toBe("function");
  });
});

describe("Field — runtime smoke for both modes", () => {
  it("renders a controlled input with value + onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Field name="ctrl" label="Controlled" value="abc" onChange={onChange} />,
    );
    const input = screen.getByDisplayValue("abc") as HTMLInputElement;
    expect(input).toHaveAttribute("name", "ctrl");
    await user.type(input, "d");
    expect(onChange).toHaveBeenCalled();
  });

  it("renders an uncontrolled input with inputRef + defaultValue", () => {
    const ref = createRef<HTMLInputElement>();
    render(
      <Field
        name="unctrl"
        label="Uncontrolled"
        inputRef={ref}
        defaultValue="seeded"
      />,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.value).toBe("seeded");
    expect(ref.current?.name).toBe("unctrl");
  });
});
