import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAccountClient } from "../account-client.js";

const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account-client", () => {
  it("读取本地账号会话真实路由", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("http://127.0.0.1:18100/api/account/session");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });

      return new Response(
        JSON.stringify({
          authenticated: true,
          isNewUser: false,
          profile: {
            userId: "user-1",
            email: "grace@example.com",
            phoneNumber: null,
            nickname: "Grace",
            avatarUrl: null,
            planType: "trial",
            hasFinishedGuide: true,
            region: "cn",
            registeredAt: "2026-06-02T10:00:00.000Z"
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createHttpAccountClient(config).getSession()).resolves.toMatchObject({
      authenticated: true,
      profile: {
        email: "grace@example.com",
        nickname: "Grace",
        registeredAt: "2026-06-02T10:00:00.000Z"
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("通过真实本地 API 完成注册、登录和昵称更新", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });

      if (url.endsWith("/api/account/register")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({ username: "grace", password: "Passw0rd1" });
        return jsonResponse({
          session: {
            authenticated: true,
            isNewUser: true,
            profile: profilePayload({ nickname: "Grace" })
          },
          provisioning: provisioningPayload()
        });
      }

      if (url.endsWith("/api/account/login")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({ username: "grace", password: "Passw0rd1" });
        return jsonResponse({
          session: {
            authenticated: true,
            isNewUser: false,
            profile: profilePayload({ nickname: "Grace" })
          },
          provisioning: provisioningPayload()
        });
      }

      if (url.endsWith("/api/account/profile")) {
        expect(init?.method).toBe("PATCH");
        expect(body).toEqual({ nickname: "Memmy User" });
        return jsonResponse(profilePayload({ nickname: "Memmy User" }));
      }

      if (url.endsWith("/api/account/invitation")) {
        expect(init?.method).toBe("PUT");
        return jsonResponse({
          enabled: true,
          invitationCode: "MEMMY-A1B2C3",
          usedInviteSlotsToday: 3,
          dailySuccessLimit: 5,
          remainingInvitesToday: 2,
          dailyLimitReached: false
        });
      }

      if (url.endsWith("/api/account/guide-finished")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({});
        return jsonResponse({ ok: true });
      }

      if (url.endsWith("/api/account/logout")) {
        expect(init?.method).toBe("POST");
        expect(body).toEqual({});
        return jsonResponse({ ok: true });
      }

      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpAccountClient(config);

    await expect(client.register({ username: "grace", password: "Passw0rd1" })).resolves.toMatchObject({
      session: {
        authenticated: true,
        isNewUser: true,
        profile: { email: "grace@example.com", nickname: "Grace" }
      },
      provisioning: { apiKey: "cr-desktop-key", model: "gpt-oss-120b" }
    });
    await expect(client.login({ username: "grace", password: "Passw0rd1" })).resolves.toMatchObject({
      session: {
        authenticated: true,
        isNewUser: false,
        profile: { email: "grace@example.com", nickname: "Grace" }
      },
      provisioning: { apiBase: "https://cuberouter.example/v1" }
    });
    await expect(client.getInvitation()).resolves.toMatchObject({
      invitationCode: "MEMMY-A1B2C3",
      remainingInvitesToday: 2
    });
    await expect(client.updateProfile({ nickname: "Memmy User" })).resolves.toMatchObject({
      email: "grace@example.com",
      nickname: "Memmy User",
      registeredAt: "2026-06-02T10:00:00.000Z"
    });
    await expect(client.markGuideFinished()).resolves.toEqual({ ok: true });
    await expect(client.logout()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

/**
 * Builds a JSON response.
 *
 * @param payload The response body object.
 * @returns A Response that fetch can consume.
 */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Builds the model provisioning payload returned by register and login.
 *
 * @returns A provisioning payload that conforms to the local API contract.
 */
function provisioningPayload() {
  return {
    apiKey: "cr-desktop-key",
    apiBase: "https://cuberouter.example/v1",
    model: "gpt-oss-120b"
  };
}

/**
 * Builds an account profile response.
 *
 * @param input Overridable account fields.
 * @returns An account profile that conforms to the local API contract.
 */
function profilePayload(input: { nickname: string }) {
  return {
    userId: "user-1",
    email: "grace@example.com",
    phoneNumber: null,
    nickname: input.nickname,
    avatarUrl: null,
    planType: "trial",
    hasFinishedGuide: false,
    region: "cn",
    registeredAt: "2026-06-02T10:00:00.000Z"
  };
}
