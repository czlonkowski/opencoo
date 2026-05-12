-- Migration 0013 — `intake_status` gains a `'failed'` terminal value
-- (phase-a appendix #14 PR-W3). The compile-worker wraps its body in
-- a try/catch that writes `status='failed' + error_class + error_text`
-- before re-throwing for BullMQ, closing the silent-failure gap that
-- left ~260 intake rows pinned at `pending` for 20+ hours when the
-- classifier guard rejected wildcard-only bindings.
--
-- `IF NOT EXISTS` keeps the migration safely re-runnable on environments
-- where it has already been applied (e.g. the design-partner deployment
-- that hand-applied the enum value during incident response).

ALTER TYPE "public"."intake_status" ADD VALUE IF NOT EXISTS 'failed';