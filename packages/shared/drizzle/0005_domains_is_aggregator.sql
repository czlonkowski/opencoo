-- Migration 0005 — `domains.is_aggregator` for the worldview
-- compilation pipeline (PR 22 / plan #106).
--
-- Adds a boolean column flagging the (at most one) aggregator
-- domain that compiles `company.md` from every other domain's
-- `worldview.md`. The complementary sovereignty constraint
-- (the company-compile pipeline MUST NOT read non-`worldview.md`
-- paths from non-aggregator domains) is enforced in code +
-- pinned by a readPage spy in the integration test.
--
-- The partial UNIQUE INDEX ensures at most one aggregator can
-- ever exist concurrently — a second `UPDATE … SET
-- is_aggregator=true` on a different row violates the index
-- before the application sees it.

ALTER TABLE "domains" ADD COLUMN "is_aggregator" boolean DEFAULT false NOT NULL;
CREATE UNIQUE INDEX "domains_is_aggregator_singleton" ON "domains" ("is_aggregator") WHERE "is_aggregator" = true;
