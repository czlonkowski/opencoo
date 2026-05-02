/**
 * In-process SSE event bus for the Activity tab (phase-a appendix #4 PR-B).
 *
 * A simple EventEmitter-backed bus that:
 *   - carries per-token streaming events from the LLM router
 *   - carries agent-run lifecycle events (started / completed / failed)
 *
 * The bus lives in engine-self-operating's process and is passed to:
 *   1. The SSE route handler (`routes/events.ts`) which subscribes on
 *      connect and sends events to the browser over the SSE stream.
 *   2. The LLM router streaming path, which calls `emitToken` for each
 *      chunk of an in-flight run.
 *
 * THREAT-MODEL §2 invariant 11: `emitToken` with `includePrompt=false`
 * strips the `promptText` field before broadcasting. The SSE route
 * always sets `includePrompt` to the value of `LLM_DEBUG_LOG`. No
 * prompt content reaches subscribers unless the gate is open.
 *
 * The bus is intentionally simple:
 *   - No persistence. The SSE stream is live-only; a reconnecting
 *     client gets a fresh `connected` event and sees only future events.
 *   - No backpressure. Engine-self-operating is single-process; the
 *     burst of tokens from one LLM call is bounded by the provider's
 *     chunk rate.
 */
import { EventEmitter } from "node:events";

/** A single LLM token emitted during a streaming run. */
export interface TokenEvent {
  readonly runId: string;
  readonly token: string;
  readonly promptText?: string; // present only when includePrompt=true
}

/** A structured run lifecycle event (started / completed / failed). */
export interface RunEvent {
  readonly runId: string;
  readonly definitionSlug: string;
  readonly status: "running" | "success" | "failed" | "timeout";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: string;
  readonly latencyMs?: number;
  readonly errorClass?: string;
}

export interface EmitTokenArgs {
  readonly runId: string;
  readonly token: string;
  /** Optional prompt text to attach. Only emitted when
   *  `includePrompt=true`. THREAT-MODEL §2 invariant 11. */
  readonly promptText?: string;
  /** Set to `true` only when `LLM_DEBUG_LOG=1`. */
  readonly includePrompt: boolean;
}

export interface SseBus {
  /** Emit a streaming token event. Gated by `includePrompt`. */
  emitToken(args: EmitTokenArgs): void;
  /** Subscribe to token events. Returns an unsubscribe function. */
  onToken(listener: (e: TokenEvent) => void): () => void;

  /** Emit a run lifecycle event. */
  emitRunEvent(event: RunEvent): void;
  /** Subscribe to run events. Returns an unsubscribe function. */
  onRunEvent(listener: (e: RunEvent) => void): () => void;
}

const TOKEN_EVENT = "token";
const RUN_EVENT = "run";

/** Factory that returns a fresh SSE bus backed by a Node EventEmitter. */
export function createSseBus(): SseBus {
  const emitter = new EventEmitter();
  // Bump the listener ceiling — the SSE route registers one listener per
  // connected admin session; a deployment with a handful of concurrent
  // operators may exceed the default of 10. 100 is a generous ceiling
  // for a single-instance self-hosted product.
  emitter.setMaxListeners(100);

  return {
    emitToken(args: EmitTokenArgs): void {
      const event: TokenEvent = args.includePrompt && args.promptText !== undefined
        ? { runId: args.runId, token: args.token, promptText: args.promptText }
        : { runId: args.runId, token: args.token };
      emitter.emit(TOKEN_EVENT, event);
    },

    onToken(listener: (e: TokenEvent) => void): () => void {
      emitter.on(TOKEN_EVENT, listener);
      return () => emitter.off(TOKEN_EVENT, listener);
    },

    emitRunEvent(event: RunEvent): void {
      emitter.emit(RUN_EVENT, event);
    },

    onRunEvent(listener: (e: RunEvent) => void): () => void {
      emitter.on(RUN_EVENT, listener);
      return () => emitter.off(RUN_EVENT, listener);
    },
  };
}
