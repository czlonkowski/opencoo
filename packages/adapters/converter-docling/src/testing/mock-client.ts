/**
 * Test seam — a table-driven DoclingClient. Lookup is by
 * `(filename, mimeType)` pair; unknown calls throw loudly so tests
 * never silently fall back to a default that hides missing coverage.
 */
import type {
  DoclingClient,
  DoclingClientConvertArgs,
  DoclingClientResponse,
} from "../client.js";

export interface MockDoclingEntry {
  readonly filename: string;
  readonly mimeType: string;
  readonly response: DoclingClientResponse | "throw";
}

export type MockDoclingObserver = (args: DoclingClientConvertArgs) => void;

/**
 * Minimal mock: one lookup table, one optional observer. The observer
 * lets use-case tests assert on the exact bytes/mimeType/filename the
 * adapter passed through — no direct spy library needed.
 */
export class MockDoclingClient implements DoclingClient {
  private readonly entries: ReadonlyArray<MockDoclingEntry>;
  private readonly observer: MockDoclingObserver | undefined;

  constructor(
    entries: ReadonlyArray<MockDoclingEntry>,
    observer?: MockDoclingObserver,
  ) {
    this.entries = entries;
    this.observer = observer;
  }

  async convert(
    args: DoclingClientConvertArgs,
  ): Promise<DoclingClientResponse> {
    if (this.observer !== undefined) this.observer(args);
    const match = this.entries.find(
      (e) => e.filename === args.filename && e.mimeType === args.mimeType,
    );
    if (match === undefined) {
      throw new Error(
        `MockDoclingClient: no registered entry for (${args.filename}, ${args.mimeType}). Registered: ${this.entries
          .map((e) => `(${e.filename}, ${e.mimeType})`)
          .join(", ") || "none"}`,
      );
    }
    if (match.response === "throw") {
      throw new Error(
        `MockDoclingClient: simulated malformed-input failure for ${args.filename}`,
      );
    }
    return match.response;
  }
}
