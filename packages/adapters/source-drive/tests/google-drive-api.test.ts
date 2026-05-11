/**
 * Unit tests for the real Drive client wiring (PR-Z1, phase-a
 * appendix #12).
 *
 * Coverage split. The boundary the production composition root
 * cares about is:
 *
 *   1. `parseServiceAccountJson` — does the defensive parser
 *      catch the obvious operator mistakes (bad JSON, wrong
 *      shape, missing required fields) and return a clear
 *      error message in each case? These are the failure modes
 *      that surface when an operator pastes a half-truncated
 *      key into the credential form, so the assertions are
 *      message-string asserts, not structural asserts — the
 *      operator reads the message in the UI.
 *   2. `createGoogleDriveApi` — does the factory return the
 *      three `DriveLikeApi` methods the adapter calls? We
 *      DON'T exercise the methods themselves here — that
 *      requires a live Drive (covered by the
 *      `RUN_REAL_DRIVE`-gated integration test) AND would
 *      require mocking the entire `googleapis` SDK, which has
 *      no value beyond rebuilding the SDK's own tests. The
 *      contract verification that consumers see is the
 *      type-level shape pin from `DriveLikeApi`.
 *
 * Anything beyond this lives in the gated real-API test.
 */
import { describe, expect, it } from "vitest";

import {
  createGoogleDriveApi,
  filterChangesByFolderId,
  isMarkdownExportUnavailable,
  parseServiceAccountJson,
  type RawDriveChange,
  type ServiceAccountKey,
} from "../src/google-drive-api.js";

// A minimal-but-syntactically-real PKCS#8 private key. The
// JWT class in google-auth-library validates the PEM envelope
// at construction time on some versions; using a real-shaped
// key avoids that being a flake source. The key never leaves
// the test process — no live Drive call is made.
const FIXTURE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj
MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu
NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ
qgtzJ6GR3eqoYSW9b9UMvkBpZODSctWSNGj3P7jRFDO5VoTwCQAWbFnOjDfH5Ulg
p2PKSQnSJP3AJLQNFNe7br1XbrhV//eO+t51mIpGSDCUv3E0DDFcWDTH9cXDTTlR
ZVEiR2BwpZOOkE/Z0/BVnhZYL71oZV34bKfWjQIt6V/isSMahdsAASACp4ZTGtwi
VuNd9tybAgMBAAECggEBAKTmjaS6tkK8BlPXClTQ2vpz/N6uxDeS35mXpqasqskV
laAidgg/sWqpjXDbXr93otIMLlWsM+X0CqMDgSXKejLS2jx4GDjI1ZTXg++0AMJ8
sJ74pWzVDOfmCEQ/7wXs3+cbnXhKriO8Z036q92Qc1+N87SI38nkGa0ABH9CN83H
mQqt4fB7UdHzuIRe/me2PGhIq5ZBzj6h3BpoPGzEP+x3l9YmK8t/1cN0pqI+dQwY
dgfGjackLu/2qH80MCF7IyQaseZUOJyKrCLtSD/Iixv/hzDEUPfOCjFDgTpzf3cw
ta8+oE4wHCo1iI1/4TlPkwmXx4qSXtmw4aQPz7IDQvECgYEA8KNThCO2gsC2I9PQ
DM/8Cw0O983WCDY+oi+7JPiNAJwv5DYBqEZB1QYdj06YD16XlC/HAZMsMku1na2T
N0driwenQQWzoev3g2S7gRDoS/FCJSI3jJ+kjgtaA7Qmzlgk1TxODN+G1H91HW7t
0l7VnL27IWyYo2qRRK3jzxqUiPUCgYEAx0oQs2reBQGMVZnApD1jeq7n4MvNLcPv
t8b/eU9iUv6Y4Mj0Suo/AU8lYZXm8ubbqAlwz2VSVunD2tOplHyMUrtCtObAfVDU
AhCndKaA9gApgfb3xw1IKbuQ1u4IF1FJl3VtumfQn//LiH1B3rXhcdyo3/vIttEk
48RakUKClU8CgYEAzV7W3COOlDDcQd935DdtKBFRAPRPAlspQUnzMi5eSHMD/ISL
DY5IiQHbIH83D4bvXq0X7qQoSBSNP7Dvv3HYuqMhf0DaegrlBuJllFVVq9qPVRnK
xt1Il2HgxOBvbhOT+9in1BzA+YJ99UzC85O0Qz06A+CmtHEy4aZ2kj5hHjECgYEA
mNS4+A8Fkss8Js1RieK2LniBxMgmYml3pfVLKGnzmng7H2+cwPLhPIzIuwytXywh
2bzbsYEfYx3EoEVgMEpPhoarQnYPukrJO4gwE2o5Te6T5mJSZGlQJQj9q4ZB2Dfz
et6INsK0oG8XVGXSpQvQh3RUYekCZQkBBFcpqWpbIEsCgYAnM3DQf3FJoSnXaMhr
VBIovic5l0xFkEHskAjFTevO86Fsz1C2aSeRKSqGFoOQ0tmJzBEs1R6KqnHInicD
TQrKhArgLXX4v3CddjfTRJkFWDbE/CkvKZNOrcf1nhaGCPspRJj2KUkj1Fhl9Cnc
dn/RsYEONbwQSjIfMPkvxF+8HQ==
-----END PRIVATE KEY-----`;

// ---------------------------------------------------------------------------
// parseServiceAccountJson — happy + each documented failure
// ---------------------------------------------------------------------------

describe("parseServiceAccountJson — happy path", () => {
  it("returns the minimal {client_email, private_key} subset", () => {
    const raw = JSON.stringify({
      type: "service_account",
      project_id: "estyl-pilot",
      private_key_id: "abc123",
      private_key: FIXTURE_PRIVATE_KEY,
      client_email: "drive-reader@estyl-pilot.iam.gserviceaccount.com",
      client_id: "111222333",
    });
    const parsed = parseServiceAccountJson(raw);
    expect(parsed.client_email).toBe(
      "drive-reader@estyl-pilot.iam.gserviceaccount.com",
    );
    expect(parsed.private_key).toBe(FIXTURE_PRIVATE_KEY);
  });

  it("ignores unknown extra fields (the SA file ships ~7 fields, we read 2)", () => {
    const raw = JSON.stringify({
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: FIXTURE_PRIVATE_KEY,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      universe_domain: "googleapis.com",
    });
    const parsed = parseServiceAccountJson(raw);
    expect(parsed.client_email).toBe("x@y.iam.gserviceaccount.com");
  });
});

describe("parseServiceAccountJson — defensive failures", () => {
  it("rejects malformed JSON with a clear 'not valid JSON' message", () => {
    expect(() => parseServiceAccountJson("{not json")).toThrow(
      /service-account JSON is not valid JSON/,
    );
  });

  it("rejects a JSON array (must be an object)", () => {
    expect(() => parseServiceAccountJson("[]")).toThrow(
      /must be an object with client_email \+ private_key/,
    );
  });

  it("rejects null at the top level (must be an object)", () => {
    expect(() => parseServiceAccountJson("null")).toThrow(
      /must be an object with client_email \+ private_key/,
    );
  });

  it("rejects a JSON primitive (number)", () => {
    expect(() => parseServiceAccountJson("42")).toThrow(
      /must be an object with client_email \+ private_key/,
    );
  });

  it("rejects missing client_email with a typed error", () => {
    const raw = JSON.stringify({ private_key: FIXTURE_PRIVATE_KEY });
    expect(() => parseServiceAccountJson(raw)).toThrow(
      /missing required field 'client_email'/,
    );
  });

  it("rejects empty-string client_email", () => {
    const raw = JSON.stringify({
      client_email: "",
      private_key: FIXTURE_PRIVATE_KEY,
    });
    expect(() => parseServiceAccountJson(raw)).toThrow(
      /missing required field 'client_email'/,
    );
  });

  it("rejects missing private_key with a typed error", () => {
    const raw = JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com" });
    expect(() => parseServiceAccountJson(raw)).toThrow(
      /missing required field 'private_key'/,
    );
  });

  it("rejects empty-string private_key", () => {
    const raw = JSON.stringify({
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: "",
    });
    expect(() => parseServiceAccountJson(raw)).toThrow(
      /missing required field 'private_key'/,
    );
  });

  it("rejects non-string client_email (numbers, objects)", () => {
    const raw = JSON.stringify({
      client_email: 12345,
      private_key: FIXTURE_PRIVATE_KEY,
    });
    expect(() => parseServiceAccountJson(raw)).toThrow(
      /missing required field 'client_email'/,
    );
  });
});

// ---------------------------------------------------------------------------
// createGoogleDriveApi — factory shape + DriveLikeApi contract
// ---------------------------------------------------------------------------

describe("createGoogleDriveApi — DriveLikeApi shape", () => {
  it("returns an object exposing the three contract methods", () => {
    const sa: ServiceAccountKey = {
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: FIXTURE_PRIVATE_KEY,
    };
    const api = createGoogleDriveApi(sa);
    expect(typeof api.getStartPageToken).toBe("function");
    expect(typeof api.listChanges).toBe("function");
    expect(typeof api.exportAsBytes).toBe("function");
    // Sanity: the result is the bound shape, not a class
    // instance the caller could subclass — this matches
    // makeMockDrive's plain-object return.
    expect(Object.getPrototypeOf(api)).toBe(Object.prototype);
  });

  it("constructs without making network calls (no 'await' needed at boot)", () => {
    // The factory MUST be synchronous. The composition root
    // calls it inside an adapter factory closure; if it were
    // async, every adapter factory would need to await it
    // and the contract would break. This is a compile-time
    // pin (factory return is `DriveLikeApi`, not `Promise<…>`)
    // but we also assert the runtime shape.
    const sa: ServiceAccountKey = {
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: FIXTURE_PRIVATE_KEY,
    };
    const api = createGoogleDriveApi(sa);
    // Not a Promise; not a thenable.
    expect(typeof (api as { then?: unknown }).then).toBe("undefined");
  });
});

// ---------------------------------------------------------------------------
// filterChangesByFolderId — C1 fix-up
//
// The C1 review found that the post-fetch filter previously
// guarded the folderId-include test with `parents.length > 0
// && …` — a `parents: []` payload (legitimate for root-moved
// files, shared-link-only access, certain shared-drive items,
// or field-mask edge cases) would silently widen scope past
// the binding's folderId. The strict include-test now always
// fires; these tests pin that contract.
// ---------------------------------------------------------------------------

const TARGET_FOLDER = "target-folder-id";
const DOC_MIME = "application/vnd.google-apps.document";
const ANY_DOC_MIMES = [DOC_MIME] as const;

interface RawDriveFile {
  readonly id?: string | null;
  readonly modifiedTime?: string | null;
  readonly mimeType?: string | null;
  readonly parents?: readonly string[] | null;
}

function makeChange(
  fileId: string,
  parents: readonly string[] | null | undefined,
  overrides: Partial<RawDriveFile> = {},
): RawDriveChange {
  return {
    fileId,
    removed: false,
    file: {
      id: fileId,
      modifiedTime: "2026-05-11T00:00:00.000Z",
      mimeType: DOC_MIME,
      parents: parents ?? undefined,
      ...overrides,
    },
  };
}

describe("filterChangesByFolderId — C1 scope-leak fix", () => {
  it("skips entries with parents: [] (the C1 bug — empty parents must NOT widen scope)", () => {
    const raw: RawDriveChange[] = [makeChange("file-a", [])];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toEqual([]);
  });

  it("skips entries with parents: undefined / missing (defensive — same as empty)", () => {
    const raw: RawDriveChange[] = [makeChange("file-a", undefined)];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toEqual([]);
  });

  it("skips entries with parents: ['other-folder'] (no match → drop)", () => {
    const raw: RawDriveChange[] = [makeChange("file-a", ["other-folder"])];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toEqual([]);
  });

  it("keeps entries with parents: ['target-folder-id'] (binding match)", () => {
    const raw: RawDriveChange[] = [makeChange("file-a", [TARGET_FOLDER])];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.fileId).toBe("file-a");
    expect(result[0]?.removed).toBe(false);
    expect(result[0]?.mimeType).toBe(DOC_MIME);
    expect(result[0]?.revision).toBe("2026-05-11T00:00:00.000Z");
  });

  it("keeps entries with multi-parent including target (file shared across folders)", () => {
    const raw: RawDriveChange[] = [
      makeChange("file-a", ["other-folder", TARGET_FOLDER, "third-folder"]),
    ];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toHaveLength(1);
  });

  it("emits removed=true entries unconditionally (no parents check on tombstones)", () => {
    // Removed events flow through with a missing `file`
    // payload by design — the adapter's `removed` filter
    // drops them downstream, but the boundary must surface
    // the event so the dedupe logic sees it.
    const raw: RawDriveChange[] = [
      { fileId: "deleted-file", removed: true, file: null },
    ];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.removed).toBe(true);
    expect(result[0]?.fileId).toBe("deleted-file");
  });

  it("filters by mimeType before parents (off-whitelist mime → drop)", () => {
    const raw: RawDriveChange[] = [
      makeChange("file-a", [TARGET_FOLDER], {
        mimeType: "application/vnd.google-apps.spreadsheet",
      }),
    ];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toEqual([]);
  });

  it("skips entries with missing/empty fileId (defensive)", () => {
    const raw: RawDriveChange[] = [
      { fileId: undefined, removed: false, file: null },
      { fileId: "", removed: false, file: null },
    ];
    const result = filterChangesByFolderId(raw, {
      folderId: TARGET_FOLDER,
      mimeTypes: ANY_DOC_MIMES,
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isMarkdownExportUnavailable — I1 predicate-narrowing fix
//
// The I1 review found the helper was too broad: any 400 (auth,
// malformed-fileId, etc.) would downgrade to text/plain. The
// helper now inspects `errors[0].reason === "exportFormatUnsupported"`
// with a defensive message-regex fallback. The `code === "400"`
// string-form branch (I2 fold-in) is removed — gaxios@6.x uses
// a numeric code.
// ---------------------------------------------------------------------------

describe("isMarkdownExportUnavailable — I1 predicate matrix", () => {
  it("returns true for the canonical signal (errors[0].reason: 'exportFormatUnsupported')", () => {
    const err = {
      code: 400,
      errors: [{ reason: "exportFormatUnsupported" }],
    };
    expect(isMarkdownExportUnavailable(err)).toBe(true);
  });

  it("returns false for a 400 with a DIFFERENT reason (permissionDenied)", () => {
    const err = {
      code: 400,
      errors: [{ reason: "permissionDenied" }],
    };
    expect(isMarkdownExportUnavailable(err)).toBe(false);
  });

  it("returns true for a 400 with a message-only signal ('Format not available')", () => {
    const err = {
      code: 400,
      message: "Format not available for this file",
    };
    expect(isMarkdownExportUnavailable(err)).toBe(true);
  });

  it("returns true for 'format is not supported' message variant", () => {
    const err = {
      code: 400,
      message: "Export format is not supported for the requested file",
    };
    expect(isMarkdownExportUnavailable(err)).toBe(true);
  });

  it("returns false for a 401 (auth error) regardless of message", () => {
    const err = { code: 401, message: "Invalid credentials" };
    expect(isMarkdownExportUnavailable(err)).toBe(false);
  });

  it("returns false for a non-error input (null / primitive / undefined)", () => {
    expect(isMarkdownExportUnavailable(null)).toBe(false);
    expect(isMarkdownExportUnavailable(undefined)).toBe(false);
    expect(isMarkdownExportUnavailable("400")).toBe(false);
    expect(isMarkdownExportUnavailable(400)).toBe(false);
  });

  it("returns false for a 400 with an unrelated message and no errors[]", () => {
    // A malformed-fileId 400, for instance — message contains
    // none of the format-unavailable signals.
    const err = {
      code: 400,
      message: "File not found: bogus-file-id",
    };
    expect(isMarkdownExportUnavailable(err)).toBe(false);
  });

  it("supports SDK versions surfacing the status on `status` instead of `code`", () => {
    const err = {
      status: 400,
      errors: [{ reason: "exportFormatUnsupported" }],
    };
    expect(isMarkdownExportUnavailable(err)).toBe(true);
  });

  it("regex matches the loosely-named reason 'fileFormatUnsupported' too", () => {
    // The regex /exportFormat|formatUnsupported/i intentionally
    // catches both Drive's canonical 'exportFormatUnsupported'
    // and the looser 'fileFormatUnsupported' variant some API
    // versions emit.
    const err = {
      code: 400,
      errors: [{ reason: "fileFormatUnsupported" }],
    };
    expect(isMarkdownExportUnavailable(err)).toBe(true);
  });
});
