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
