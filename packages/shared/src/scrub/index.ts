/**
 * `@opencoo/shared/scrub` — credential-scrubbing utilities.
 *
 * Currently exports only `scrubPat`, used to sanitise error strings
 * before they reach API responses or logs (THREAT-MODEL §3.6
 * invariant 11). Additional scrubbers can be added here without
 * touching callers.
 */
export { scrubPat } from "./pat-scrub.js";
