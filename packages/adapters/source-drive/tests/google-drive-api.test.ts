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
  parseServiceAccountJson,
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
