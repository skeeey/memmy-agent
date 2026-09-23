/** Cuberouter client tests. */
import { describe, expect, it, vi } from "vitest";
import { createHttpCuberouterClient } from "../index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function clientWith(fetchImpl: typeof fetch) {
  return createHttpCuberouterClient({
    baseUrl: "http://127.0.0.1:3000",
    timeoutMs: 1000,
    fetchImpl
  });
}

describe("cuberouter client", () => {
  it("logs in and maps the dashboard access token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        message: "",
        data: {
          access_token: "jwt-1",
          user: { id: 7, username: "alice", display_name: "Alice", quota: 100 }
        }
      })
    );
    const session = await clientWith(fetchImpl as unknown as typeof fetch).login({
      username: "alice",
      password: "Passw0rd1"
    });

    expect(session).toEqual({
      accessToken: "jwt-1",
      userId: "7",
      username: "alice",
      displayName: "Alice"
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/user/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ username: "alice", password: "Passw0rd1" });
  });

  it("reports two-factor logins instead of returning an unusable session", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, message: "", data: { require_2fa: true } })
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).login({ username: "alice", password: "Passw0rd1" })
    ).rejects.toMatchObject({ code: "two_factor_required" });
  });

  it("surfaces the server message for rejected requests", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false, message: "用户名已存在" }));

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).register({ username: "alice", password: "Passw0rd1" })
    ).rejects.toMatchObject({ code: "rejected", message: "用户名已存在" });
  });

  it("lists tokens with id and name", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
      return jsonResponse({
        success: true,
        message: "",
        data: { page: 1, page_size: 10, total: 2, items: [{ id: 3, name: "memmy-desktop", key: "sk-***" }, { id: 4, name: "other", key: "sk-***" }] }
      });
    });

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).listTokens("jwt-1")
    ).resolves.toEqual([
      { id: 3, name: "memmy-desktop" },
      { id: 4, name: "other" }
    ]);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/token/?p=1&page_size=100");
    expect(init.method).toBe("GET");
  });

  it("reads every token page so a later page cannot hide an existing token", async () => {
    // The reuse branch scans this list by name: a token that only shows up on page 2 would
    // otherwise be invisible, and each login would create a duplicate token.
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `token-${index + 1}` }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const page = Number(new URL(String(url)).searchParams.get("p"));
      return jsonResponse({
        success: true,
        message: "",
        data: {
          page,
          page_size: 100,
          total: 101,
          items: page === 1 ? firstPage : [{ id: 101, name: "memmy-desktop" }]
        }
      });
    });

    const tokens = await clientWith(fetchImpl as unknown as typeof fetch).listTokens("jwt-1");

    expect(tokens).toHaveLength(101);
    expect(tokens).toContainEqual({ id: 101, name: "memmy-desktop" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String((fetchImpl.mock.calls[1] as [string])[0])).toBe("http://127.0.0.1:3000/api/token/?p=2&page_size=100");
  });

  it("honours the page size the server reports instead of the one requested", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const page = Number(new URL(String(url)).searchParams.get("p"));
      return jsonResponse({
        success: true,
        message: "",
        data: {
          page,
          page_size: 2,
          total: 3,
          items: page === 1
            ? [{ id: 1, name: "one" }, { id: 2, name: "two" }]
            : [{ id: 3, name: "memmy-desktop" }]
        }
      });
    });

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).listTokens("jwt-1")
    ).resolves.toEqual([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
      { id: 3, name: "memmy-desktop" }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("creates a never-expiring unlimited token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      jsonResponse({ success: true, message: "" })
    );

    await clientWith(fetchImpl as unknown as typeof fetch).createToken("jwt-1", { name: "memmy-desktop" });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/token/");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "memmy-desktop",
      expired_time: -1,
      unlimited_quota: true,
      remain_quota: 0,
      model_limits_enabled: false,
      group: ""
    });
  });

  it("reads the plaintext key of an existing token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      jsonResponse({ success: true, message: "", data: { key: "sk-plain" } })
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).getTokenKey("jwt-1", 3)
    ).resolves.toBe("sk-plain");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/token/3/key");
    expect(init.method).toBe("POST");
  });

  it("reads the signed-in profile from the self endpoint", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
      return jsonResponse({
        success: true,
        message: "",
        data: { id: 7, username: "alice", display_name: "Alice", quota: 100 }
      });
    });

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).getSelf("jwt-1")
    ).resolves.toEqual({ userId: "7", username: "alice", displayName: "Alice", quota: 100 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/user/self");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
  });

  it("surfaces the server message when the auth middleware rejects the request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, code: "unauthorized", message: "access token expired" }, 401)
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).listTokens("stale-token")
    ).rejects.toMatchObject({ code: "rejected", message: "access token expired" });
  });

  it("maps transport failures to service_unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).login({ username: "alice", password: "Passw0rd1" })
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("reads the registration requirements the target instance advertises", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // /api/status is public: sending the runtime token or a bearer here would leak a
      // credential to an endpoint that never asked for one.
      expect(init?.headers).toEqual({});
      return jsonResponse({
        success: true,
        message: "",
        data: { email_verification: true, turnstile_check: true, register_enabled: true }
      });
    });

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).getRegistrationRequirements()
    ).resolves.toEqual({ emailVerificationRequired: true, turnstileRequired: true, serverAddress: null });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/status");
    expect(init.method).toBe("GET");
  });

  it("reads the server address the instance names itself with", async () => {
    // The node self-identifies here; a probe compares it against the URL it dialed, which is
    // how a rewritten route (DNS or proxy) becomes visible instead of silently working.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        message: "",
        data: { server_address: "https://cuberouter.com" }
      })
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).getRegistrationRequirements()
    ).resolves.toEqual({
      emailVerificationRequired: false,
      turnstileRequired: false,
      serverAddress: "https://cuberouter.com"
    });
  });

  it("lets a probe cut the status call short with its own timeout", async () => {
    // Without the override this call would wait out the client's default timeout; a probe
    // must be able to bound itself so two slow nodes cannot stall the registration form.
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const startedAt = Date.now();

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).getRegistrationRequirements({ timeoutMs: 20 })
    ).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("treats missing status flags as not required", async () => {
    // An instance that predates or renames these fields must degrade to today's form
    // (no extra inputs), not to a form that can never submit.
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, message: "", data: {} }));

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).getRegistrationRequirements()
    ).resolves.toEqual({ emailVerificationRequired: false, turnstileRequired: false, serverAddress: null });
  });

  it("sends the email and verification code only when registering with them", async () => {
    const responses = [
      jsonResponse({ success: true, message: "" }),
      jsonResponse({
        success: true,
        message: "",
        data: { access_token: "jwt-1", user: { id: 7, username: "alice" } }
      })
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);

    await clientWith(fetchImpl as unknown as typeof fetch).register({
      username: "alice",
      password: "Passw0rd1",
      email: "alice@example.com",
      verificationCode: "123456"
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      username: "alice",
      password: "Passw0rd1",
      email: "alice@example.com",
      verification_code: "123456"
    });
  });

  it("omits the email fields when the instance does not verify email", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, message: "" }));

    await clientWith(fetchImpl as unknown as typeof fetch).register({ username: "alice", password: "Passw0rd1" });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ username: "alice", password: "Passw0rd1" });
  });

  it("requests a verification code for the given address", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({});
      return jsonResponse({ success: true, message: "" });
    });

    await clientWith(fetchImpl as unknown as typeof fetch).sendEmailVerificationCode("alice+test@example.com");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/verification?email=alice%2Btest%40example.com");
    expect(init.method).toBe("GET");
  });

  it("reports the send-code rate limit with its own code", async () => {
    // The only endpoint in this client that answers 429: cuberouter allows two sends per
    // IP per 30s, and the desktop shows a different message for that than for a rejection.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, message: "发送过于频繁，请等待 28 秒后再试" }, 429)
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).sendEmailVerificationCode("alice@example.com")
    ).rejects.toMatchObject({ code: "email_code_throttled" });
  });

  it("surfaces the server message when the verification code is wrong", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, message: "验证码错误或已过期" })
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).register({
        username: "alice",
        password: "Passw0rd1",
        email: "alice@example.com",
        verificationCode: "000000"
      })
    ).rejects.toMatchObject({ code: "rejected", message: "验证码错误或已过期" });
  });

  it("maps a failure while reading the response body to service_unavailable", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        text: async () => {
          throw new TypeError("terminated");
        }
      }) as unknown as Response
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).getSelf("jwt-1")
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });
});
