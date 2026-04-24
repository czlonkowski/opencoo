/**
 * GiteaClient port — narrow surface over the four Gitea REST endpoints
 * the WikiAdapter needs. Raw `fetch`, no `gitea-js` (Correction C from
 * team-lead): smaller supply chain, exact request shape under our
 * control, easier to mock.
 *
 * The endpoints used by `GiteaRestClient`:
 *
 *   GET  /api/v1/repos/{owner}/{repo}/branches/{branch}
 *   GET  /api/v1/repos/{owner}/{repo}/contents/{path}?ref={sha}
 *   POST /api/v1/repos/{owner}/{repo}/contents              (ChangeFilesOptions — batch)
 *   GET  /api/v1/repos/{owner}/{repo}/git/commits/{sha}
 *
 * The port is deliberately Gitea-shaped (file changes carry base64
 * content; stale-detect leans on Gitea's `sha`-mismatch 409). Two
 * implementations consume it: `GiteaRestClient` (real wire) and
 * `MockGiteaClient` in `./testing/mock-client.ts`.
 *
 * Stale-detect contract: `commitFiles` returns `{ status: 'stale',
 * currentSha }` when the request's `parentSha` no longer matches the
 * branch HEAD. The adapter passes this through to its
 * `WriteAtomicResult`. NEVER throw on stale — it's the normal path.
 */

// ---------------------------------------------------------------------------
// Port shapes
// ---------------------------------------------------------------------------

export interface GiteaRepoLocator {
  readonly owner: string;
  readonly name: string;
}

export interface GiteaFileContent {
  readonly content: string;
  readonly sha: string;
}

export type GiteaFileChange =
  | {
      readonly mode: "create" | "update";
      readonly path: string;
      readonly contentBase64: string;
      /** SHA of the file's previous version. Required for `update` so
       *  Gitea can detect concurrent edits to the same file. */
      readonly fromSha?: string;
    }
  | {
      readonly mode: "delete";
      readonly path: string;
      readonly fromSha: string;
    };

export interface CommitFilesArgs {
  readonly repo: GiteaRepoLocator;
  readonly branch: string;
  readonly parentSha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly files: ReadonlyArray<GiteaFileChange>;
}

export type CommitFilesResult =
  | { readonly status: "ok"; readonly commitSha: string }
  | { readonly status: "stale"; readonly currentSha: string };

export interface CommitInspection {
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
}

export interface GiteaClient {
  /** Returns the HEAD commit sha of the branch. */
  getBranchSha(repo: GiteaRepoLocator, branch: string): Promise<string>;
  /** Returns file content + blob-sha at the given commit; `null` for
   *  missing files (so the adapter can map to `readPage` → null). */
  getFileContent(
    repo: GiteaRepoLocator,
    path: string,
    ref: string,
  ): Promise<GiteaFileContent | null>;
  /** Atomic batch commit. Stale-detect returns ok|stale; transport
   *  failures throw `WikiTransportError`. */
  commitFiles(args: CommitFilesArgs): Promise<CommitFilesResult>;
  /** Optional commit-metadata reader, used by the contract suite's
   *  CommitInspector path (assertions 8/9/10). */
  inspectCommit(repo: GiteaRepoLocator, sha: string): Promise<CommitInspection>;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

export interface GiteaRestClientOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface BranchResponse {
  readonly commit?: { readonly id?: unknown };
}

interface ContentsResponse {
  readonly content?: unknown;
  readonly sha?: unknown;
  readonly type?: unknown;
}

interface CommitResponse {
  readonly message?: unknown;
  readonly commit?: {
    readonly message?: unknown;
    readonly author?: {
      readonly name?: unknown;
      readonly email?: unknown;
    };
  };
  readonly author?: {
    readonly login?: unknown;
    readonly email?: unknown;
  };
}

interface ChangeFilesResponse {
  readonly commit?: { readonly sha?: unknown };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Raw-fetch GiteaClient. Trims trailing slashes from the URL and uses
 * the documented `Authorization: token <pat>` header style (Gitea
 * accepts `Bearer` too but `token` keeps logs unambiguous).
 */
export class GiteaRestClient implements GiteaClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GiteaRestClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getBranchSha(
    repo: GiteaRepoLocator,
    branch: string,
  ): Promise<string> {
    const path = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches/${encodeURIComponent(branch)}`;
    const response = await this.request("GET", path);
    if (!response.ok) {
      throw new Error(
        `Gitea getBranchSha ${repo.owner}/${repo.name}@${branch} → HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body)) {
      throw new Error(
        `Gitea getBranchSha returned non-object for ${repo.owner}/${repo.name}@${branch}`,
      );
    }
    const commit = (body as BranchResponse).commit;
    if (!isObject(commit) || typeof commit.id !== "string") {
      throw new Error(
        `Gitea getBranchSha response missing commit.id for ${repo.owner}/${repo.name}@${branch}`,
      );
    }
    return commit.id;
  }

  async getFileContent(
    repo: GiteaRepoLocator,
    filePath: string,
    ref: string,
  ): Promise<GiteaFileContent | null> {
    const path = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`;
    const response = await this.request("GET", path);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Gitea getFileContent ${repo.owner}/${repo.name}/${filePath} → HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body)) {
      throw new Error(
        `Gitea getFileContent returned non-object for ${repo.owner}/${repo.name}/${filePath}`,
      );
    }
    const cb = body as ContentsResponse;
    // Directory listings come back as arrays — the adapter only ever
    // asks for a file path, so anything non-file is a caller bug.
    if (cb.type !== "file") {
      throw new Error(
        `Gitea getFileContent expected file at ${filePath}, got ${String(cb.type)}`,
      );
    }
    if (typeof cb.content !== "string" || typeof cb.sha !== "string") {
      throw new Error(
        `Gitea getFileContent malformed response for ${filePath}`,
      );
    }
    return {
      content: Buffer.from(cb.content, "base64").toString("utf8"),
      sha: cb.sha,
    };
  }

  async commitFiles(args: CommitFilesArgs): Promise<CommitFilesResult> {
    const path = `/api/v1/repos/${encodeURIComponent(args.repo.owner)}/${encodeURIComponent(args.repo.name)}/contents`;
    // Gitea's ChangeFilesOptions: `branch`, `new_branch?`, `message`,
    // `author`, `committer`, `dates`, `files: [{operation, path,
    // content?, sha?, from_path?}]`. We pin author=committer and skip
    // dates so the server timestamps the commit.
    const body = {
      branch: args.branch,
      message: args.message,
      author: { name: args.authorName, email: args.authorEmail },
      committer: { name: args.authorName, email: args.authorEmail },
      files: args.files.map((f) => {
        if (f.mode === "delete") {
          return { operation: "delete", path: f.path, sha: f.fromSha };
        }
        const base = {
          operation: f.mode, // "create" | "update"
          path: f.path,
          content: f.contentBase64,
        };
        return f.fromSha !== undefined ? { ...base, sha: f.fromSha } : base;
      }),
    };
    const response = await this.request("POST", path, body);
    // Gitea returns 409 when sha-mismatch on update — that's the
    // stale-detect signal we surface to the adapter.
    if (response.status === 409) {
      const currentSha = await this.getBranchSha(args.repo, args.branch);
      return { status: "stale", currentSha };
    }
    if (!response.ok) {
      throw new Error(
        `Gitea commitFiles ${args.repo.owner}/${args.repo.name} → HTTP ${response.status}`,
      );
    }
    const data: unknown = await response.json();
    if (!isObject(data)) {
      throw new Error(
        `Gitea commitFiles returned non-object for ${args.repo.owner}/${args.repo.name}`,
      );
    }
    const cf = data as ChangeFilesResponse;
    if (!isObject(cf.commit) || typeof cf.commit.sha !== "string") {
      throw new Error(
        `Gitea commitFiles response missing commit.sha for ${args.repo.owner}/${args.repo.name}`,
      );
    }
    return { status: "ok", commitSha: cf.commit.sha };
  }

  async inspectCommit(
    repo: GiteaRepoLocator,
    sha: string,
  ): Promise<CommitInspection> {
    const path = `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/commits/${encodeURIComponent(sha)}`;
    const response = await this.request("GET", path);
    if (!response.ok) {
      throw new Error(
        `Gitea inspectCommit ${repo.owner}/${repo.name}@${sha} → HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (!isObject(body)) {
      throw new Error(
        `Gitea inspectCommit returned non-object for ${sha}`,
      );
    }
    // Two ways Gitea exposes message + author: top-level (per-commit
    // surface) and nested under `commit` (git-commit shape). Prefer
    // the nested shape; the top-level `author` is the GITEA USER, not
    // the git author of the commit.
    const cb = body as CommitResponse;
    const nested = cb.commit;
    let message: string;
    let authorName: string;
    let authorEmail: string;
    if (
      isObject(nested) &&
      typeof nested.message === "string" &&
      isObject(nested.author) &&
      typeof nested.author.name === "string" &&
      typeof nested.author.email === "string"
    ) {
      message = nested.message;
      authorName = nested.author.name;
      authorEmail = nested.author.email;
    } else if (typeof cb.message === "string") {
      message = cb.message;
      // Fallback — Gitea-user shape (top-level author). authorName
      // best-effort via login; authorEmail straight through.
      const topAuthor = cb.author;
      authorName =
        isObject(topAuthor) && typeof topAuthor.login === "string"
          ? topAuthor.login
          : "";
      authorEmail =
        isObject(topAuthor) && typeof topAuthor.email === "string"
          ? topAuthor.email
          : "";
    } else {
      throw new Error(`Gitea inspectCommit malformed response for ${sha}`);
    }
    return { message, authorName, authorEmail };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `token ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        signal: controller.signal,
        // Conditional spread: under exactOptionalPropertyTypes, RequestInit.body
        // does not accept `undefined` — the field has to be ABSENT, not present-but-undefined.
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      };
      return await this.fetchImpl(`${this.url}${path}`, init);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * encodeURIComponent escapes `/`, but Gitea's `/contents/{path}` wants
 * the path to keep its slashes. Encode each segment, then rejoin.
 */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
