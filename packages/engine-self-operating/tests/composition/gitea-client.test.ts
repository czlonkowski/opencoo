/**
 * createGiteaClient tests (PR 30 / plan #135).
 *
 * Load-bearing security pin: the PAT bytes NEVER appear in
 * any thrown error.message — even on network drops, 4xx
 * responses, or malformed JSON. The grep test below seeds a
 * known-distinct PAT value and asserts it doesn't surface in
 * any error message string.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createGiteaClient,
  stripPat,
} from "../../src/composition/gitea-client.js";

const SECRET_PAT = "secret-pat-do-not-leak-1234567890abcdef";

describe("createGiteaClient — happy path", () => {
  it("resolves whoami via /user + /user/teams", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: "alice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { name: "opencoo-admins", organization: { username: "opencoo" } },
            { name: "engineers", organization: { username: "opencoo" } },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const client = createGiteaClient({
      baseUrl: "https://gitea.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.whoami(SECRET_PAT);
    expect(result.username).toBe("alice");
    // Both forms surface so `ADMIN_TEAM_SLUG=opencoo-admins`
    // OR `ADMIN_TEAM_SLUG=opencoo/opencoo-admins` work.
    expect(result.teams).toContain("opencoo-admins");
    expect(result.teams).toContain("opencoo/opencoo-admins");
    expect(result.teams).toContain("engineers");
    expect(result.teams).toContain("opencoo/engineers");
    // The Authorization header carries `token <pat>`.
    const userCallInit = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((userCallInit.headers as Record<string, string>).authorization).toBe(
      `token ${SECRET_PAT}`,
    );
  });
});

describe("createGiteaClient — error paths", () => {
  async function expectThrowWithoutPat(
    invoke: () => Promise<unknown>,
  ): Promise<Error> {
    try {
      await invoke();
    } catch (err) {
      if (err instanceof Error) {
        // Load-bearing assertion — the PAT value MUST NOT
        // surface anywhere in error.message.
        expect(err.message).not.toContain(SECRET_PAT);
        return err;
      }
      throw new Error(`expected an Error, got ${typeof err}`);
    }
    throw new Error("expected the invocation to throw");
  }

  it("4xx response does NOT leak the PAT in error.message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("invalid token", { status: 401 }),
    );
    const client = createGiteaClient({
      baseUrl: "https://gitea.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await expectThrowWithoutPat(() => client.whoami(SECRET_PAT));
    // 4xx body is surfaced for context but the PAT isn't.
    expect(err.message).toContain("401");
  });

  it("network drop does NOT leak the PAT in error.message", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => {
      throw new Error(`network unreachable; sent ${SECRET_PAT}`);
    });
    const client = createGiteaClient({
      baseUrl: "https://gitea.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await expectThrowWithoutPat(() => client.whoami(SECRET_PAT));
    expect(err.message).toContain("gitea fetch failed");
    // Verify the cause-stripping replaced the PAT bytes.
    expect(err.message).toContain("[REDACTED:pat]");
  });

  it("malformed JSON body does NOT leak the PAT", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not-json-at-all", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createGiteaClient({
      baseUrl: "https://gitea.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expectThrowWithoutPat(() => client.whoami(SECRET_PAT));
  });

  it("/user response missing `login` is a clear error (no PAT leak)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createGiteaClient({
      baseUrl: "https://gitea.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await expectThrowWithoutPat(() => client.whoami(SECRET_PAT));
    expect(err.message).toContain("login");
  });
});

describe("stripPat helper", () => {
  it("replaces every literal occurrence of the PAT with [REDACTED:pat]", () => {
    expect(stripPat(`prefix ${SECRET_PAT} suffix`, SECRET_PAT)).toBe(
      "prefix [REDACTED:pat] suffix",
    );
  });

  it("is a no-op when the PAT is empty", () => {
    expect(stripPat("anything", "")).toBe("anything");
  });

  it("leaves the input alone when the PAT doesn't appear", () => {
    expect(stripPat("nothing-to-redact", SECRET_PAT)).toBe("nothing-to-redact");
  });
});
