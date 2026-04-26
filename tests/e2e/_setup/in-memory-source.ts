/**
 * Minimal in-memory SourceAdapter for the e2e ingest-to-wiki
 * test (PR 32 / plan #149).
 *
 * The production Drive adapter needs Google credentials, a
 * `makeDrive` factory, OAuth refresh — all of which are out of
 * scope for the phase-a e2e gate. This adapter implements
 * exactly the SourceAdapter port the Scanner pipeline calls
 * (`scan({cursor})` → `{documents, nextCursor}`), seeded with
 * a fixed list of documents.
 *
 * The Scanner contract: each call returns documents that
 * "changed since cursor" plus a new cursor for the next call.
 * We satisfy this with a monotonic counter in the seed list —
 * `cursor === null` returns ALL seeded docs; subsequent calls
 * with the cursor return nothing. The e2e tests only do one
 * scan per test, so the simpler shape suffices.
 */
import type {
  SourceAdapter,
  SourceChangedDocument,
  SourceScanArgs,
  SourceScanResult,
} from "../../../packages/shared/src/source-adapter/index.js";

export interface SeededDocument {
  readonly sourceDocId: string;
  readonly sourceRevision: string;
  readonly sourceRef: string;
  readonly contentBytes: Buffer;
}

export interface InMemorySourceAdapterOptions {
  readonly slug?: string;
  readonly documents: readonly SeededDocument[];
}

/** Construct an in-memory SourceAdapter pre-seeded with the
 *  given document set. The first scan returns every doc with
 *  fetchedAt = now and cursor = "1"; subsequent scans return
 *  empty (deterministic for a one-shot test). */
export function createInMemorySource(
  opts: InMemorySourceAdapterOptions,
): SourceAdapter {
  const slug = opts.slug ?? "e2e-inmem";
  const seeded: readonly SourceChangedDocument[] = opts.documents.map((d) => ({
    sourceDocId: d.sourceDocId,
    sourceRevision: d.sourceRevision,
    sourceRef: d.sourceRef,
    fetchedAt: new Date(),
    contentBytes: d.contentBytes,
  }));
  return {
    slug,
    async scan(args: SourceScanArgs): Promise<SourceScanResult> {
      if (args.cursor === null) {
        return { documents: seeded, nextCursor: "1" };
      }
      return { documents: [], nextCursor: args.cursor };
    },
  };
}
