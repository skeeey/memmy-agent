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

  it("maps transport failures to service_unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).login({ username: "alice", password: "Passw0rd1" })
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });
});
