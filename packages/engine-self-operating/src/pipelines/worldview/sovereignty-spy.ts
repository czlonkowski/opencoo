/**
 * Sovereignty-asserting WikiAdapter wrapper (PR 22 / plan #106).
 *
 * Wraps any WikiAdapter so that any `readPage(slug, path)`
 * call where `path !== 'worldview.md'` AND `slug !==
 * aggregatorOwnSlug` throws `WorldviewSovereigntyError`. The
 * production engine boot path wires this around the real
 * adapter when it constructs the company-aggregator pipeline;
 * the integration test pins the assertion via the same
 * wrapper.
 *
 * `writeAtomic`, `getHeadSha`, `listMarkdown` pass through
 * unchanged — the constraint is read-side only (the
 * aggregator legitimately writes its own `company.md`).
 */
import type {
  WikiAdapter,
  WriteAtomicArgs,
  WriteAtomicResult,
} from "@opencoo/shared/wiki-write";

import { WorldviewSovereigntyError } from "./errors.js";
import { SOVEREIGN_AGGREGATOR_INPUT_PATH } from "./compile-company.js";

export interface SovereigntySpyOptions {
  readonly inner: WikiAdapter;
  /** The aggregator domain's own slug — reads from THIS
   *  domain are unrestricted (the aggregator legitimately
   *  reads its own pages, e.g. its own `company.md` or
   *  scratch pages). */
  readonly aggregatorOwnSlug: string;
}

export class SovereigntySpyWikiAdapter implements WikiAdapter {
  private readonly inner: WikiAdapter;
  private readonly aggregatorOwnSlug: string;
  private readonly _violationLog: Array<{
    readonly slug: string;
    readonly path: string;
  }> = [];

  constructor(options: SovereigntySpyOptions) {
    this.inner = options.inner;
    this.aggregatorOwnSlug = options.aggregatorOwnSlug;
  }

  /** Per-call violation log. Empty in healthy runs; populated
   *  if something tried (and was rejected). Tests use this for
   *  diagnostic output when a regression fires. */
  get violationLog(): readonly { readonly slug: string; readonly path: string }[] {
    return [...this._violationLog];
  }

  async getHeadSha(
    slug: Parameters<WikiAdapter["getHeadSha"]>[0],
  ): Promise<string> {
    return this.inner.getHeadSha(slug);
  }

  async listMarkdown(
    slug: Parameters<WikiAdapter["listMarkdown"]>[0],
  ): Promise<readonly string[]> {
    return this.inner.listMarkdown(slug);
  }

  async readPage(
    slug: Parameters<WikiAdapter["readPage"]>[0],
    path: Parameters<WikiAdapter["readPage"]>[1],
  ): ReturnType<WikiAdapter["readPage"]> {
    if (
      slug !== this.aggregatorOwnSlug &&
      path !== SOVEREIGN_AGGREGATOR_INPUT_PATH
    ) {
      this._violationLog.push({ slug, path });
      throw new WorldviewSovereigntyError(slug, path);
    }
    return this.inner.readPage(slug, path);
  }

  async writeAtomic(args: WriteAtomicArgs): Promise<WriteAtomicResult> {
    return this.inner.writeAtomic(args);
  }
}
