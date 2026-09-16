/** Cuberouter account service tests. */
import { describe, expect, it, vi } from "vitest";
import type { CuberouterClient } from "../../adapters/outbound/cuberouter-client/index.js";
import { createCuberouterAccountService } from "../cuberouter-account-service.js";

function fakeClient(overrides: Partial<CuberouterClient> = {}): CuberouterClient {
  return {
    register: vi.fn(async () => undefined),
    login: vi.fn(async () => ({
      accessToken: "jwt-1",
      userId: "7",
      username: "alice",
      displayName: "Alice"
    })),
    listTokens: vi.fn(async () => []),
    createToken: vi.fn(async () => undefined),
    getTokenKey: vi.fn(async () => "sk-plain"),
    getSelf: vi.fn(async () => ({ userId: "7", username: "alice", displayName: "Alice", quota: 0 })),
    ...overrides
  };
}

function fakeRepository() {
  const upsert = vi.fn((input: any) => ({
    authenticated: true,
    isNewUser: input.isNewUser ?? false,
    profile: { ...input.profile, registeredAt: null }
  }));
  return {
    repository: { upsert, clear: vi.fn() } as any,
    upsert
  };
}

describe("cuberouter account service", () => {
  it("registers then logs in and provisions a fresh key", async () => {
    // A fresh account lists no token, and the token created below shows up on the
    // re-list (cuberouter does not return the id of a newly created token).
    const client = fakeClient({
      listTokens: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: 3, name: "memmy-desktop" }])
    });
    const { repository, upsert } = fakeRepository();
    const service = createCuberouterAccountService({
      client,
      accountSessionRepository: repository,
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash"
    });

    const result = await service.register({ username: "alice", password: "Passw0rd1" });

    expect(client.register).toHaveBeenCalledWith({ username: "alice", password: "Passw0rd1" });
    expect(client.createToken).toHaveBeenCalledWith("jwt-1", { name: "memmy-desktop" });
    expect((client.listTokens as any).mock.calls.length).toBe(2);
    expect(result.provisioning).toEqual({
      apiKey: "sk-plain",
      apiBase: "http://127.0.0.1:3000/v1",
      model: "deepseek-flash"
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: "cuberouter:7",
        cloudUuid: "jwt-1",
        authChannel: "cuberouter",
        profile: expect.objectContaining({ identityProvider: "cuberouter", nickname: "Alice" })
      })
    );
  });

  it("reuses the existing memmy-desktop token on later logins", async () => {
    const client = fakeClient({
      listTokens: vi.fn(async () => [{ id: 3, name: "memmy-desktop" }])
    });
    const { repository } = fakeRepository();
    const service = createCuberouterAccountService({
      client,
      accountSessionRepository: repository,
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash"
    });

    const result = await service.login({ username: "alice", password: "Passw0rd1" });

    expect(client.createToken).not.toHaveBeenCalled();
    expect(client.getTokenKey).toHaveBeenCalledWith("jwt-1", 3);
    expect(result.provisioning.apiKey).toBe("sk-plain");
  });

  it("fails when the freshly created token cannot be listed", async () => {
    const client = fakeClient({ listTokens: vi.fn(async () => []) });
    const { repository } = fakeRepository();
    const service = createCuberouterAccountService({
      client,
      accountSessionRepository: repository,
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash"
    });

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toMatchObject({
      code: "invalid_argument"
    });
  });

  it("maps cuberouter failures onto the local API error contract", async () => {
    const client = fakeClient({
      login: vi.fn(async () => {
        throw Object.assign(new Error("用户名或密码不正确"), { code: "rejected" });
      })
    });
    const { repository } = fakeRepository();
    const service = createCuberouterAccountService({
      client,
      accountSessionRepository: repository,
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash"
    });

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "用户名或密码不正确"
    });
  });

  it("maps transport failures to a code the desktop renders while keeping the message", async () => {
    const client = fakeClient({
      login: vi.fn(async () => {
        throw Object.assign(new Error("无法连接 cuberouter 服务"), { code: "service_unavailable" });
      })
    });
    const { repository } = fakeRepository();
    const service = createCuberouterAccountService({
      client,
      accountSessionRepository: repository,
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash"
    });

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toMatchObject({
      code: "cuberouter_unavailable",
      message: "无法连接 cuberouter 服务"
    });
  });

  it("clears the local session on logout without calling cuberouter", async () => {
    const client = fakeClient();
    const { repository } = fakeRepository();
    const service = createCuberouterAccountService({
      client,
      accountSessionRepository: repository,
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash"
    });

    await expect(service.logout()).resolves.toEqual({ ok: true });
    expect(repository.clear).toHaveBeenCalled();
  });
});
