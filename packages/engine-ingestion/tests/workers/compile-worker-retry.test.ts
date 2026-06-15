import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";

import {
  TransientError,
  UpstreamQuotaError,
  ValidationError,
} from "@opencoo/shared/errors";

import { mapWorkerError } from "../../src/workers/compile-worker.js";

// The classify queue runs with attempts:5 so transient provider blips
// drain. A `validation`-class failure (malformed classifier output,
// shape-guard reject) will never succeed on retry, so it must DLQ
// immediately rather than burn 5 attempts (Copilot triage).
describe("mapWorkerError — classify-queue retry gating", () => {
  it("maps a validation-class error to BullMQ UnrecoverableError (no retry)", () => {
    const mapped = mapWorkerError(new ValidationError("bad classifier shape"));
    expect(mapped).toBeInstanceOf(UnrecoverableError);
    expect((mapped as Error).message).toContain("bad classifier shape");
  });

  it("passes a transient error through unchanged (BullMQ retries per attempts)", () => {
    const err = new TransientError("provider 503");
    expect(mapWorkerError(err)).toBe(err);
  });

  it("passes an upstream-quota error through unchanged (retries with backoff)", () => {
    const err = new UpstreamQuotaError("budget cap");
    expect(mapWorkerError(err)).toBe(err);
  });

  it("passes a non-Opencoo error through unchanged (treated transient → retry)", () => {
    const err = new Error("boom");
    expect(mapWorkerError(err)).toBe(err);
  });
});
