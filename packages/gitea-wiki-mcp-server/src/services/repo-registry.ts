/**
 * Maps a repo `slug` (as passed by tool callers) to the on-disk clone path +
 * its config entry. A missing slug resolves to the configured default repo.
 */
import path from "node:path";
import type { Config, RepoEntry } from "../config.js";

export class UnknownRepoError extends Error {
  constructor(slug: string, available: string[]) {
    super(
      `Unknown repo "${slug}". Known slugs: ${available.join(", ") || "(none)"}`,
    );
    this.name = "UnknownRepoError";
  }
}

export interface ResolvedRepo {
  entry: RepoEntry;
  /** Absolute path to the cloned repo on disk. */
  repoPath: string;
  /** Absolute path to the index.json for this repo. */
  indexPath: string;
}

export class RepoRegistry {
  private bySlug: Map<string, RepoEntry>;
  private defaultSlug: string;
  private readonly dataDir: string;

  constructor(config: Config) {
    this.bySlug = new Map(config.repos.map((r) => [r.slug, r]));
    // loadConfig() guarantees exactly one default.
    const def = config.repos.find((r) => r.default);
    if (!def) throw new Error("BUG: no default repo (config validation missed)");
    this.defaultSlug = def.slug;
    this.dataDir = config.dataDir;
  }

  /**
   * Replace the in-memory repo set wholesale. Used by the
   * `POST /refresh-all` endpoint so opencoo can keep this server's
   * REPOS list in sync with the engine's `domains` table without an
   * operator-maintained JSON array in `.env` (G10, phase-a appendix
   * #12 PR-Z8).
   *
   * Caller MUST have already validated entry shapes via
   * `validateRepos` (the endpoint does this). The same default-of-one
   * + unique-slug invariants the constructor depends on are
   * re-enforced here so a partial application can't drift the
   * registry into an unrecoverable state.
   */
  replace(repos: ReadonlyArray<RepoEntry>): void {
    if (repos.length === 0) {
      throw new Error("RepoRegistry.replace: repos array must be non-empty");
    }
    const defaults = repos.filter((r) => r.default);
    if (defaults.length !== 1) {
      throw new Error(
        `RepoRegistry.replace: exactly one repo must have default:true (found ${defaults.length})`,
      );
    }
    const seen = new Set<string>();
    for (const r of repos) {
      if (seen.has(r.slug)) {
        throw new Error(
          `RepoRegistry.replace: duplicate slug "${r.slug}"`,
        );
      }
      seen.add(r.slug);
    }
    this.bySlug = new Map(repos.map((r) => [r.slug, r]));
    this.defaultSlug = defaults[0]!.slug;
  }

  /**
   * Resolve optional slug to a repo bundle. Throws UnknownRepoError if the
   * slug doesn't match any configured repo.
   */
  resolve(slug?: string): ResolvedRepo {
    const effective = slug ?? this.defaultSlug;
    const entry = this.bySlug.get(effective);
    if (!entry) {
      throw new UnknownRepoError(effective, [...this.bySlug.keys()]);
    }
    return {
      entry,
      repoPath: path.join(this.dataDir, "repos", entry.slug),
      indexPath: path.join(this.dataDir, "index", `${entry.slug}.json`),
    };
  }

  list(): RepoEntry[] {
    return [...this.bySlug.values()];
  }

  getDefaultSlug(): string {
    return this.defaultSlug;
  }
}
