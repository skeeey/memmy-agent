/** Account routes tests. */
import { afterEach, describe, expect, it } from "vitest";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("account local api routes", () => {
  it("forwards account session routes through AccountService", async () => {
    const calls: string[] = [];
    app = createServer({
      account: {
        async getInvitation() {
          calls.push("invitation");
          return {
            enabled: true,
            invitationCode: "MEMMY-A1B2C3",
            usedInviteSlotsToday: 3,
            dailySuccessLimit: 5,
            remainingInvitesToday: 2,
            dailyLimitReached: false
          };
        },
        async updateProfile(input) {
          calls.push(`profile:${input.nickname}`);
          return { ...accountSession().profile, nickname: input.nickname };
        },
        async markGuideFinished() {
          calls.push("guide-finished");
          return { ok: true };
        },
        async logout() {
          calls.push("logout");
          return { ok: true };
        },
        async getSession() {
          calls.push("session");
          return accountSession();
        }
      }
    });

    const invitation = await injectJson("PUT", "/api/account/invitation", {});
    const profile = await injectJson("PATCH", "/api/account/profile", { nickname: "Memmy User" });
    const guideFinished = await injectJson("POST", "/api/account/guide-finished", {});
    const logout = await injectJson("POST", "/api/account/logout", {});
    const session = await app.inject({
      method: "GET",
      url: "/api/account/session",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(invitation.json()).toMatchObject({
      invitationCode: "MEMMY-A1B2C3",
      remainingInvitesToday: 2
    });
    expect(profile.json()).toMatchObject({ nickname: "Memmy User" });
    expect(guideFinished.json()).toEqual({ ok: true });
    expect(logout.json()).toEqual({ ok: true });
    expect(session.json()).toMatchObject({ authenticated: true });
    expect(calls).toEqual([
      "invitation",
      "profile:Memmy User",
      "guide-finished",
      "logout",
      "session"
    ]);
  });

  it("registers through the cuberouter account service and returns the provisioning payload", async () => {
    const calls: string[] = [];
    app = createServer({
      cuberouterAccount: {
        async register(input: { username: string; password: string }) {
          calls.push(`register:${input.username}`);
          return {
            session: {
              authenticated: true,
              isNewUser: true,
              profile: {
                userId: "7",
                email: null,
                phoneNumber: null,
                nickname: "Alice",
                avatarUrl: null,
                planType: null,
                hasFinishedGuide: null,
                region: null,
                registeredAt: null,
                identityProvider: "cuberouter"
              }
            },
            provisioning: {
              apiKey: "sk-plain",
              apiBase: "http://127.0.0.1:3000/v1",
              model: "deepseek-flash"
            }
          };
        },
        async login() {
          throw new Error("login not used");
        },
        async logout() {
          return { ok: true };
        }
      }
    });

    const response = await injectJson("POST", "/api/account/register", {
      username: "alice",
      password: "Passw0rd1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().provisioning.apiKey).toBe("sk-plain");
    expect(calls).toEqual(["register:alice"]);
  });

  it("serves the instance registration requirements behind the runtime token", async () => {
    app = createServer({
      cuberouterAccount: {
        async getRegistrationRequirements() {
          return { emailVerificationRequired: true, turnstileRequired: false };
        }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/account/registration-requirements",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ emailVerificationRequired: true, turnstileRequired: false });
  });

  it("sends a verification code to the requested address", async () => {
    const calls: string[] = [];
    app = createServer({
      cuberouterAccount: {
        async sendEmailVerificationCode(email: string) {
          calls.push(`code:${email}`);
          return { ok: true };
        }
      }
    });

    const response = await injectJson("POST", "/api/account/email-code", { email: "alice@example.com" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(calls).toEqual(["code:alice@example.com"]);
  });

  it("rejects a malformed address before it reaches the instance", async () => {
    app = createServer();

    const response = await injectJson("POST", "/api/account/email-code", { email: "not-an-email" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_argument");
  });

  it("surfaces a throttled code send as 429 with the server message", async () => {
    app = createServer({
      cuberouterAccount: {
        async sendEmailVerificationCode() {
          throw Object.assign(new Error("发送过于频繁，请等待 28 秒后再试"), { code: "rate_limited" });
        }
      }
    });

    const response = await injectJson("POST", "/api/account/email-code", { email: "alice@example.com" });

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({
      code: "rate_limited",
      message: "发送过于频繁，请等待 28 秒后再试"
    });
  });

  it("serves the configured lines, the current line, and the probe default", async () => {
    app = createServer({
      cuberouterAccount: {
        async getNodes() {
          return { nodes: ["cn", "hk"], currentNodeId: "cn" };
        },
        async probeNodes() {
          return { nodes: ["cn", "hk"], defaultNodeId: "hk" };
        }
      }
    });

    const nodes = await app.inject({
      method: "GET",
      url: "/api/account/nodes",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const probe = await injectJson("POST", "/api/account/nodes/probe");

    expect(nodes.statusCode).toBe(200);
    expect(nodes.json()).toEqual({ nodes: ["cn", "hk"], currentNodeId: "cn" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ nodes: ["cn", "hk"], defaultNodeId: "hk" });
  });

  it("passes the line the caller is looking at to the requirements probe", async () => {
    const asked: Array<string | undefined> = [];
    app = createServer({
      cuberouterAccount: {
        async getRegistrationRequirements(nodeId?: string) {
          asked.push(nodeId);
          return { emailVerificationRequired: nodeId === "hk", turnstileRequired: false };
        }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/account/registration-requirements?nodeId=hk",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(asked).toEqual(["hk"]);
    expect(response.json()).toMatchObject({ emailVerificationRequired: true });
  });

  it("lists avatars and stores the selected avatar behind the runtime token", async () => {
    const calls: string[] = [];
    app = createServer({
      appConfig: {
        async listAvatars() {
          calls.push("avatars");
          return [{ id: "memmy-default", displayName: "Memmy", assetKey: "avatar.memmy", kind: "image" }];
        },
        async setAvatar(input) {
          calls.push(`avatar:${input.avatarId}`);
          return { avatarId: input.avatarId };
        }
      }
    });

    const avatars = await app.inject({
      method: "GET",
      url: "/api/account/avatars",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const avatar = await app.inject({
      method: "PATCH",
      url: "/api/account/avatar",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { avatarId: "memmy-default" }
    });

    expect(avatars.statusCode).toBe(200);
    expect(avatars.json()).toEqual([
      { id: "memmy-default", displayName: "Memmy", assetKey: "avatar.memmy", kind: "image" }
    ]);
    expect(avatar.statusCode).toBe(200);
    expect(avatar.json()).toEqual({ avatarId: "memmy-default" });
    expect(calls).toEqual(["avatars", "avatar:memmy-default"]);
  });

  it("rejects avatar routes without a valid runtime token", async () => {
    app = createServer();

    const response = await app.inject({
      method: "GET",
      url: "/api/account/avatars"
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects credentials that violate the shared schema", async () => {
    app = createServer();

    const response = await injectJson("POST", "/api/account/login", {
      username: "alice",
      password: "short"
    });

    expect(response.statusCode).toBe(400);
  });
});

async function injectJson(method: string, url: string, payload: unknown) {
  if (!app) {
    throw new Error("Test server is not initialized");
  }

  return app.inject({
    method,
    url,
    headers: {
      "x-memmy-local-token": "test-token"
    },
    payload
  });
}

function createServer(overrides: Record<string, unknown> = {}): FastifyInstance {
  const services = {
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used");
      }
    },
    progressBus: createProgressBus(),
    appConfig: {
      async listAvatars() {
        return [];
      },
      async setAvatar() {
        return { avatarId: "memmy-default" };
      }
    },
    cuberouterAccount: {
      async register() {
        throw new Error("register not used");
      },
      async login() {
        throw new Error("login not used");
      },
      async getRegistrationRequirements() {
        return { emailVerificationRequired: false, turnstileRequired: false };
      },
      async sendEmailVerificationCode() {
        throw new Error("sendEmailVerificationCode not used");
      },
      async logout() {
        return { ok: true };
      }
    },
    account: {
      async getInvitation() {
        return {
          enabled: false,
          invitationCode: null,
          usedInviteSlotsToday: 0,
          dailySuccessLimit: 0,
          remainingInvitesToday: 0,
          dailyLimitReached: false
        };
      },
      async updateProfile() {
        return accountSession().profile;
      },
      async markGuideFinished() {
        return { ok: true };
      },
      async logout() {
        return { ok: true };
      },
      async getSession() {
        return { authenticated: false };
      }
    },
    ...overrides
  } as unknown as BackendServices;

  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    services,
    heartbeatIntervalMs: 20
  });
}

function accountSession() {
  return {
    authenticated: true,
    isNewUser: true,
    profile: {
      userId: "user-1",
      email: "hello@example.com",
      phoneNumber: null,
      nickname: "hello",
      avatarUrl: null,
      planType: "free",
      hasFinishedGuide: false,
      region: null,
      registeredAt: "2026-06-02T10:00:00.000Z"
    }
  };
}

function createPermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return "scan_and_write_skill";
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return true;
    },
    async canWriteAgentSkill() {
      return true;
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    }
  };
}
