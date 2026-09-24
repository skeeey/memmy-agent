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
    getRegistrationRequirements: vi.fn(async () => ({
      emailVerificationRequired: false,
      turnstileRequired: false,
      serverAddress: "http://127.0.0.1:3000"
    })),
    sendEmailVerificationCode: vi.fn(async () => undefined),
    listOrganizationTokens: vi.fn(async () => [{ id: 11, name: "memmy-desktop", key: "sk-org" }]),
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

const TWO_NODES = [
  { id: "cn", url: "https://cn.example" },
  { id: "hk", url: "https://hk.example" }
];

/** The shape every pre-node-table test assumes: one line, one client, one repository. */
function singleNodeService(client: CuberouterClient, repository: any) {
  return createTestService({
    nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
    client,
    repository
  });
}

/**
 * Builds the service against a fake node world: one client per URL (each recording its own
 * calls through the `on*` hooks), an in-memory line memory, and a stubbed router that never
 * touches the network.
 */
function createTestService(input: {
  nodes: Array<{ id: string; url: string }>;
  client?: CuberouterClient;
  clientsByUrl?: Record<string, CuberouterClient>;
  repository?: any;
  rememberedNodeId?: string | null;
  preferredNodeId?: string | null;
  probeDefaultNodeId?: string | null;
  onRegister?: (url: string) => void;
  onLogin?: (url: string) => void;
  onRequirements?: (url: string) => void;
  onRemember?: (username: string, nodeId: string) => void;
  onProbe?: () => void;
  organizationId?: string | null;
  organizationTokenName?: string | null;
  onOrganizationTokenLookup?: (tokenName: string, organizationId: string) => void;
  organizations?: Array<{ id: string; name: string }>;
  onOrganizationList?: () => void;
}) {
  const remembered = new Map<string, string>();
  if (input.rememberedNodeId) remembered.set("alice", input.rememberedNodeId);
  let preferred = input.preferredNodeId ?? null;
  let probeCalls = 0;
  const { repository } = input.repository
    ? { repository: input.repository }
    : fakeRepository();
  const clientFor = (url: string): CuberouterClient =>
    input.clientsByUrl?.[url]
    ?? ({
      register: async () => {
        input.onRegister?.(url);
      },
      login: async () => {
        input.onLogin?.(url);
        return { accessToken: `jwt-${url}`, userId: "7", username: "alice", displayName: "Alice" };
      },
      getRegistrationRequirements: async () => {
        input.onRequirements?.(url);
        return { emailVerificationRequired: false, turnstileRequired: false, serverAddress: url };
      },
      sendEmailVerificationCode: async () => undefined,
      listOrganizations: async () => {
        input.onOrganizationList?.();
        return input.organizations ?? [];
      },
      listOrganizationTokens: async (_token: string, organizationId: string, tokenName: string) => {
        input.onOrganizationTokenLookup?.(tokenName, organizationId);
        return [{ id: 11, name: tokenName, key: "sk-org" }];
      },
      getSelf: async () => ({ userId: "7", username: "alice", displayName: "Alice", quota: 0 })
    } satisfies CuberouterClient);

  return createCuberouterAccountService({
    clientFor: (url) => input.client ?? clientFor(url),
    accountSessionRepository: repository,
    accountNodes: {
      get: (username: string) => remembered.get(username.trim()) ?? null,
      set: (username: string, nodeId: string) => {
        remembered.set(username.trim(), nodeId);
        input.onRemember?.(username, nodeId);
      }
    },
    nodeRouter: {
      probe: async () => {
        probeCalls += 1;
        input.onProbe?.();
        return { entries: [], defaultNodeId: input.probeDefaultNodeId ?? null };
      },
      listNodes: () => input.nodes,
      getNodeUrl: (nodeId: string) => input.nodes.find((node) => node.id === nodeId)?.url ?? null,
      getPreferredNodeId: async () => preferred,
      setPreferredNodeId: async (nodeId: string) => {
        preferred = nodeId;
      }
    },
    model: "deepseek-flash",
    organizationId: input.organizationId === undefined ? "7" : input.organizationId,
    organizationTokenName: input.organizationTokenName === undefined ? null : input.organizationTokenName,
    log: () => undefined
  });
}

describe("cuberouter account service", () => {
  it("registers then logs in and provisions the organization's key", async () => {
    const client = fakeClient();
    const { repository, upsert } = fakeRepository();
    const service = singleNodeService(client, repository);

    const result = await service.register({ username: "alice", password: "Passw0rd1" });

    expect(client.register).toHaveBeenCalledWith({ username: "alice", password: "Passw0rd1" });
    expect(client.listOrganizationTokens).toHaveBeenCalledWith("jwt-1", "7", "memmy-desktop");
    expect(result.provisioning).toEqual({
      apiKey: "sk-org",
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

  it("forwards the email verification fields the instance asked for", async () => {
    const client = fakeClient();
    const { repository } = fakeRepository();
    const service = singleNodeService(client, repository);

    await service.register({
      username: "alice",
      password: "Passw0rd1",
      email: "alice@example.com",
      verificationCode: "123456"
    });

    expect(client.register).toHaveBeenCalledWith({
      username: "alice",
      password: "Passw0rd1",
      email: "alice@example.com",
      verificationCode: "123456"
    });
  });

  it("returns the registration requirements the instance advertises", async () => {
    const client = fakeClient({
      getRegistrationRequirements: vi.fn(async () => ({
        emailVerificationRequired: true,
        turnstileRequired: false
      }))
    });
    const { repository } = fakeRepository();
    const service = singleNodeService(client, repository);

    await expect(service.getRegistrationRequirements()).resolves.toEqual({
      emailVerificationRequired: true,
      turnstileRequired: false
    });
  });

  it("reports an unreachable instance when the requirements probe fails", async () => {
    // The desktop treats a failed probe as "assume no extra inputs", so the code has to
    // stay distinguishable from a schema error rather than collapsing to internal.
    const client = fakeClient({
      getRegistrationRequirements: vi.fn(async () => {
        throw Object.assign(new Error("无法连接 cuberouter 服务，请检查服务地址与网络"), {
          code: "service_unavailable" as const
        });
      })
    });
    const { repository } = fakeRepository();
    const service = singleNodeService(client, repository);

    await expect(service.getRegistrationRequirements()).rejects.toMatchObject({
      code: "cuberouter_unavailable"
    });
  });

  it("keeps the retry-shaped message when the code send is throttled", async () => {
    const client = fakeClient({
      sendEmailVerificationCode: vi.fn(async () => {
        throw Object.assign(new Error("发送过于频繁，请等待 28 秒后再试"), {
          code: "email_code_throttled" as const
        });
      })
    });
    const { repository } = fakeRepository();
    const service = singleNodeService(client, repository);

    await expect(service.sendEmailVerificationCode("alice@example.com")).rejects.toMatchObject({
      code: "rate_limited",
      message: "发送过于频繁，请等待 28 秒后再试"
    });
  });

  it("maps cuberouter failures onto the local API error contract", async () => {
    const client = fakeClient({
      login: vi.fn(async () => {
        throw Object.assign(new Error("用户名或密码不正确"), { code: "rejected" });
      })
    });
    const { repository } = fakeRepository();
    const service = singleNodeService(client, repository);

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
    const service = singleNodeService(client, repository);

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toMatchObject({
      code: "cuberouter_unavailable",
      message: "无法连接 cuberouter 服务"
    });
  });

  it("clears the local session on logout without calling cuberouter", async () => {
    const client = fakeClient();
    const { repository } = fakeRepository();
    const service = singleNodeService(client, repository);

    await expect(service.logout()).resolves.toEqual({ ok: true });
    expect(repository.clear).toHaveBeenCalled();
  });

  it("registers on the node the caller picked, and remembers it", async () => {
    const registeredOn: string[] = [];
    const remembered: Array<[string, string]> = [];
    const service = createTestService({
      nodes: TWO_NODES,
      onRegister: (url) => registeredOn.push(url),
      onRemember: (username, nodeId) => remembered.push([username, nodeId])
    });

    await service.register({ username: "alice", password: "Passw0rd1", nodeId: "hk" });

    expect(registeredOn).toEqual(["https://hk.example"]);
    expect(remembered).toEqual([["alice", "hk"]]);
  });

  it("rejects a node id that is not in the table", async () => {
    const service = createTestService({ nodes: [{ id: "cn", url: "https://cn.example" }] });

    await expect(service.register({ username: "alice", password: "Passw0rd1", nodeId: "mars" }))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("logs in on the remembered node first, and falls back to the other one", async () => {
    const attempts: string[] = [];
    const service = createTestService({
      nodes: TWO_NODES,
      rememberedNodeId: "cn",
      onLogin: (url) => {
        attempts.push(url);
        if (url === "https://cn.example") {
          throw Object.assign(new Error("无法连接"), { code: "service_unavailable" as const });
        }
      }
    });

    const result = await service.login({ username: "alice", password: "Passw0rd1" });

    expect(attempts).toEqual(["https://cn.example", "https://hk.example"]);
    expect(result.session.authenticated).toBe(true);
    expect(result.provisioning.apiBase).toBe("https://hk.example/v1");
  });

  it("stops after two attempts even when a third line exists", async () => {
    const attempts: string[] = [];
    const service = createTestService({
      nodes: [
        { id: "cn", url: "https://cn.example" },
        { id: "hk", url: "https://hk.example" },
        { id: "jp", url: "https://jp.example" }
      ],
      rememberedNodeId: "cn",
      preferredNodeId: "hk",
      probeDefaultNodeId: "jp",
      onLogin: (url) => {
        attempts.push(url);
        throw Object.assign(new Error("用户名或密码错误"), { code: "rejected" as const });
      }
    });

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toBeDefined();

    // Remembered, then the current line — the probed default is never dialed.
    expect(attempts).toEqual(["https://cn.example", "https://hk.example"]);
  });

  it("surfaces the last failure when neither node accepts the credentials", async () => {
    const service = createTestService({
      nodes: TWO_NODES,
      onLogin: () => {
        throw Object.assign(new Error("用户名或密码错误"), { code: "rejected" as const });
      }
    });

    await expect(service.login({ username: "alice", password: "Passw0rd1" }))
      .rejects.toMatchObject({ code: "invalid_argument", message: "用户名或密码错误" });
  });

  it("ignores a remembered or current line that is no longer in the table", async () => {
    const attempts: string[] = [];
    const service = createTestService({
      nodes: [{ id: "hk", url: "https://hk.example" }],
      // Both were persisted when the table still had a mainland node.
      rememberedNodeId: "cn",
      preferredNodeId: "cn",
      onLogin: (url) => attempts.push(url)
    });

    await service.login({ username: "alice", password: "Passw0rd1" });

    expect(attempts).toEqual(["https://hk.example"]);
  });

  it("reads the registration requirements from the line the caller is looking at", async () => {
    const asked: string[] = [];
    const service = createTestService({
      nodes: TWO_NODES,
      onRequirements: (url) => asked.push(url)
    });

    await expect(service.getRegistrationRequirements("hk")).resolves.toMatchObject({
      serverAddress: "https://hk.example"
    });
    expect(asked).toEqual(["https://hk.example"]);
  });

  it("sends the verification code through the line the account will be created on", async () => {
    // The code is instance-local: asking the current line for it while the user registers on
    // the other one produces a code that line cannot validate, so registration can never finish.
    const asked: string[] = [];
    const clientsByUrl = Object.fromEntries(TWO_NODES.map((node) => [node.url, {
      register: async () => undefined,
      login: async () => ({ accessToken: "jwt", userId: "7", username: "alice", displayName: "Alice" }),
      getRegistrationRequirements: async () => ({
        emailVerificationRequired: true,
        turnstileRequired: false,
        serverAddress: node.url
      }),
      sendEmailVerificationCode: async () => {
        asked.push(node.url);
      },
      listOrganizationTokens: async () => [{ id: 11, name: "memmy-desktop", key: "sk-org" }],
      getSelf: async () => ({ userId: "7", username: "alice", displayName: "Alice", quota: 0 })
    }])) as never;
    // The machine's current line is cn; the user picks hk for the new account.
    const service = createTestService({ nodes: TWO_NODES, clientsByUrl, preferredNodeId: "cn" });

    await service.sendEmailVerificationCode("alice@example.com", "hk");

    expect(asked).toEqual(["https://hk.example"]);
  });

  it("reports both lines and the one in effect", async () => {
    const service = createTestService({ nodes: TWO_NODES, preferredNodeId: "hk" });

    await expect(service.getNodes()).resolves.toEqual({ nodes: ["cn", "hk"], currentNodeId: "hk" });
  });

  it("preselects the build's default line when the probe reached nothing", async () => {
    const service = createTestService({ nodes: TWO_NODES, probeDefaultNodeId: null });

    await expect(service.probeNodes()).resolves.toEqual({ nodes: ["cn", "hk"], defaultNodeId: "hk" });
  });

  it("never names a line the table does not have, and says so plainly when there is none", async () => {
    // Defensive: the wiring always supplies at least the resolved default line, so an empty
    // table means a caller passed one. Report it as "no line", never as a phantom id.
    const service = createTestService({ nodes: [] });

    await expect(service.probeNodes()).resolves.toEqual({ nodes: [], defaultNodeId: null });
    await expect(service.register({ username: "alice", password: "Passw0rd1" }))
      .rejects.toMatchObject({ code: "invalid_argument", message: "没有可用的 cuberouter 线路" });
  });

  it("does not measure the lines when the account already has one", async () => {
    // A probe costs up to four status calls, and with a two-node table it cannot change the
    // order once the first slot is decided: the second slot is the other node either way.
    const attempts: string[] = [];
    const probes: number[] = [];
    const service = createTestService({
      nodes: TWO_NODES,
      rememberedNodeId: "cn",
      onLogin: (url) => attempts.push(url),
      onProbe: () => probes.push(1)
    });

    await service.login({ username: "alice", password: "Passw0rd1" });

    expect(attempts).toEqual(["https://cn.example"]);
    expect(probes).toEqual([]);
  });

  it("looks for the token name the build configured, and for the default one otherwise", async () => {
    const looked: string[] = [];
    const configured = createTestService({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
      organizationTokenName: "team-desktop",
      onOrganizationTokenLookup: (name) => looked.push(name)
    });
    await configured.login({ username: "alice", password: "Passw0rd1" });

    const byDefault = createTestService({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
      onOrganizationTokenLookup: (name) => looked.push(name)
    });
    await byDefault.login({ username: "alice", password: "Passw0rd1" });

    expect(looked).toEqual(["team-desktop", "memmy-desktop"]);
  });

  it("treats an all-digit organization setting as that instance's id", async () => {
    const looked: string[] = [];
    let listed = 0;
    const service = createTestService({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
      onOrganizationTokenLookup: (_name, organizationId) => looked.push(organizationId),
      onOrganizationList: () => listed += 1
    });

    await service.login({ username: "alice", password: "Passw0rd1" });

    expect(looked).toEqual(["7"]);
    expect(listed).toBe(0);
  });

  it("resolves an organization name to whatever id the instance gives it", async () => {
    // The point of naming it: the two deployments number the same organization differently.
    const looked: string[] = [];
    const service = createTestService({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
      organizationId: "MemTensor",
      organizations: [{ id: "42", name: "Other" }, { id: "9", name: "MemTensor" }],
      onOrganizationTokenLookup: (_name, organizationId) => looked.push(organizationId)
    });

    await service.login({ username: "alice", password: "Passw0rd1" });

    expect(looked).toEqual(["9"]);
  });

  it("names the organization when this line does not have it", async () => {
    const service = createTestService({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
      organizationId: "MemTensor",
      organizations: [{ id: "3", name: "Other" }]
    });

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toMatchObject({
      code: "cuberouter_key_unavailable",
      message: expect.stringContaining("MemTensor")
    });
  });

  it("asks the member to contact the administrator when the organization has no desktop token", async () => {
    // A member with no usable key cannot be provisioned. Say who can fix it rather than
    // reporting a provisioning failure they cannot act on.
    const client = fakeClient({
      listOrganizationTokens: vi.fn(async () => [{ id: 3, name: "someone-elses-key", key: "sk-other" }])
    });
    const { repository } = fakeRepository();
    const service = singleNodeService(client, repository);

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toMatchObject({
      code: "cuberouter_key_unavailable",
      message: "未取到组织 API Key，请联系管理员"
    });
  });

  it("names the missing build setting when no organization is configured", async () => {
    const client = fakeClient();
    const { repository } = fakeRepository();
    const service = createTestService({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
      client,
      repository,
      organizationId: null
    });

    await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toMatchObject({
      code: "cuberouter_key_unavailable",
      message: expect.stringContaining("MEMMY_CUBEROUTER_ORG")
    });
    expect(client.listOrganizationTokens).not.toHaveBeenCalled();
  });

  it("still measures the lines when nothing is known about the account", async () => {
    const probes: number[] = [];
    const service = createTestService({
      nodes: TWO_NODES,
      probeDefaultNodeId: "cn",
      onProbe: () => probes.push(1)
    });

    await service.login({ username: "alice", password: "Passw0rd1" });

    expect(probes).toHaveLength(1);
  });
});
