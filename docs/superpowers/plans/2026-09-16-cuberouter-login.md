# cuberouter 注册登录与模型自动配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端的验证码登录换成 cuberouter 用户名/密码注册登录，登录后自动创建/复用 API key 并把该 key + 固定模型写进 memmy 的模型配置。

**Architecture:** 后端新增一个 cuberouter 出站适配器和一个编排服务，桌面只提交用户名/密码、拿到 `{apiKey, apiBase, model}` 后复用现有的 BYOK 通路（`upsertByokPreset` → `assignCatalogPreset` → `saveModelCatalog`）写模型配置。账号身份存进现有本地会话表（`cloud_accounts` + 加密 `secret_store`，凭据从"云 uuid"换成 JWT）。

**Tech Stack:** TypeScript（后端 Fastify + zod 契约 + node:sqlite；桌面 React + vitest/happy-dom）；测库 vitest；外部依赖 cuberouter（new-api 分支的 Go 服务，REST + OpenAI 兼容 `/v1`）。

**Spec:** `docs/superpowers/specs/2026-09-16-cuberouter-login-design.md`

## Global Constraints

- 分支：`feat/cuberouter-login`（已存在，spec 已提交在此分支）。
- 提交信息用仓库现有的 conventional commits 风格，例如 `feat(auth): ...`；每个任务至少一次提交。
- **改了 `App/backend/local-api-contracts/src/index.ts` 之后，必须先 `npm run build -w @memmy/local-api-contracts`**——backend 与 desktop 都通过该 workspace 包的构建产物引用契约，不重建就看不到新增/变更的类型。
- 后端测试命令：`npm --prefix App/backend exec vitest run <path>`（后端 `test` 脚本会先 build 三个 workspace 包；直接跑单文件更快，但改过契约时要先手动 build contracts，见上一条）。
- 桌面测试命令：`npm --prefix App/frontend/desktop exec vitest run <path>`。
- 类型检查：`npm --prefix App/backend run typecheck`、`npm --prefix App/frontend/desktop run typecheck`。
- 后端测试文件放在源码旁的 `tests/` 子目录（例如 `src/services/tests/`），文件名 `<name>.test.ts`。
- 代码注释沿用现有英文风格（文件头一行 `/** X module. */`，导出函数用 JSDoc）。
- 固定模型名与地址必须来自环境变量，不硬编码在逻辑里：默认 `http://127.0.0.1:3000` 与 `deepseek-flash`。
- 目标实例默认关闭 Turnstile / 邮箱验证 / 2FA；这些情况只做错误提示，不做适配。
- **不要**把 `MEMMY_CUBEROUTER_*` 加进 edition manifest（`scripts/internal/shared/write-desktop-edition-manifest-lib.mjs`）——那里的校验要求 HTTPS origin，会挡掉本地默认值。

---

### Task 1: 契约与配置

**Files:**
- Modify: `App/backend/local-api-contracts/src/index.ts`（`AccountChannelSchema` 约 1093 行、`AccountProfileViewSchema` 约 1160 行；新 schema 追加在 account 区块末尾）
- Modify: `App/backend/src/config/service-urls.ts`
- Modify: `.env.example`
- Test: `App/backend/src/config/tests/service-urls.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `AccountChannel` 类型扩展为 `"email" | "phone" | "cuberouter"`
  - `AccountProfileView.identityProvider: "memmy_cloud" | "cuberouter"`（解析时缺省 `"memmy_cloud"`）
  - `CuberouterAuthInput = { username: string; password: string }`
  - `CuberouterProvisioning = { apiKey: string; apiBase: string; model: string }`
  - `CuberouterAuthResult = { session: AccountSessionView; provisioning: CuberouterProvisioning }`
  - `resolveCuberouterClientConfig(env): { baseUrl: string; model: string; timeoutMs: number }`

- [ ] **Step 1: 写失败的测试**

在 `App/backend/src/config/tests/service-urls.test.ts` 末尾追加（保留文件里已有的 `resolveCloudClientConfig` 用例）：

```ts
describe("resolveCuberouterClientConfig", () => {
  it("falls back to the local cuberouter instance and deepseek-flash", () => {
    expect(resolveCuberouterClientConfig({})).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash",
      timeoutMs: 10_000
    });
  });

  it("honors overrides and strips trailing slashes", () => {
    expect(
      resolveCuberouterClientConfig({
        MEMMY_CUBEROUTER_URL: "https://router.example.com/",
        MEMMY_CUBEROUTER_MODEL: "kimi-k3-a",
        MEMMY_CUBEROUTER_TIMEOUT_MS: "1500"
      })
    ).toEqual({
      baseUrl: "https://router.example.com",
      model: "kimi-k3-a",
      timeoutMs: 1_500
    });
  });
});
```

（若文件里还没有 import，补上：`import { resolveCloudClientConfig, resolveCuberouterClientConfig } from "../service-urls.js";`）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix App/backend exec vitest run src/config/tests/service-urls.test.ts`
Expected: FAIL — `resolveCuberouterClientConfig is not a function`（或 TS 报未导出）

- [ ] **Step 3: 实现配置解析**

`App/backend/src/config/service-urls.ts` 追加：

```ts
export interface CuberouterClientConfig {
  /** cuberouter base URL without a trailing slash. */
  baseUrl: string;
  /** Fixed model provisioned for desktop users. */
  model: string;
  /** Timeout ms. */
  timeoutMs: number;
}

/** Handles resolve cuberouter client config. */
export function resolveCuberouterClientConfig(env: NodeJS.ProcessEnv): CuberouterClientConfig {
  return {
    baseUrl: (env.MEMMY_CUBEROUTER_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, ""),
    model: env.MEMMY_CUBEROUTER_MODEL?.trim() || "deepseek-flash",
    timeoutMs: Number.parseInt(env.MEMMY_CUBEROUTER_TIMEOUT_MS ?? "10000", 10)
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix App/backend exec vitest run src/config/tests/service-urls.test.ts`
Expected: PASS

- [ ] **Step 5: 改契约**

`App/backend/local-api-contracts/src/index.ts`：

1) 把 `AccountChannelSchema` 改成：

```ts
export const AccountChannelSchema = z.enum(["email", "phone", "cuberouter"]);
```

2) 给 `AccountProfileViewSchema` 的字段列表末尾加一行（用 `.default()` 让既有构造点无需改动）：

```ts
    identityProvider: z.enum(["memmy_cloud", "cuberouter"]).default("memmy_cloud")
```

3) 追加新 schema（放在 account 区块内、`AccountSessionViewSchema` 之后）：

```ts
/** 定义 cuberouter 注册/登录入参，规则对齐 cuberouter 的 User 校验。 */
export const CuberouterAuthInputSchema = z.object({
    username: z.string().trim().min(1).max(50),
    password: z.string().min(8).max(20)
});
export type CuberouterAuthInput = z.infer<typeof CuberouterAuthInputSchema>;

/** 定义注册/登录后返回的模型供给信息。 */
export const CuberouterProvisioningSchema = z.object({
    apiKey: z.string().min(1),
    apiBase: z.string().url(),
    model: z.string().min(1)
});
export type CuberouterProvisioning = z.infer<typeof CuberouterProvisioningSchema>;

/** Schema for cuberouter auth result. */
export const CuberouterAuthResultSchema = z.object({
    session: AccountSessionViewSchema,
    provisioning: CuberouterProvisioningSchema
});
export type CuberouterAuthResult = z.infer<typeof CuberouterAuthResultSchema>;
```

- [ ] **Step 6: 补 .env.example**

`.env.example` 末尾追加：

```bash
# cuberouter（桌面端注册登录与模型供给）
MEMMY_CUBEROUTER_URL=http://127.0.0.1:3000
MEMMY_CUBEROUTER_MODEL=deepseek-flash
MEMMY_CUBEROUTER_TIMEOUT_MS=10000
```

- [ ] **Step 7: 类型检查**

Run: `npm --prefix App/backend run typecheck`
Expected: PASS（`identityProvider` 用了 `.default()`，既有 `AccountProfileViewSchema.parse({...})` 调用点不受影响）

- [ ] **Step 8: 提交**

```bash
git add App/backend/local-api-contracts/src/index.ts App/backend/src/config/service-urls.ts App/backend/src/config/tests/service-urls.test.ts .env.example
git commit -m "feat(auth): add cuberouter contracts and client config"
```

---

### Task 2: cuberouter HTTP 客户端

**Files:**
- Create: `App/backend/src/adapters/outbound/cuberouter-client/types.ts`
- Create: `App/backend/src/adapters/outbound/cuberouter-client/http-cuberouter-client.ts`
- Create: `App/backend/src/adapters/outbound/cuberouter-client/index.ts`
- Test: `App/backend/src/adapters/outbound/cuberouter-client/tests/http-cuberouter-client.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createHttpCuberouterClient(options: { baseUrl: string; timeoutMs: number; fetchImpl?: typeof fetch }): CuberouterClient`
  - `CuberouterClient`：
    - `register(input: { username: string; password: string }): Promise<void>`
    - `login(input: { username: string; password: string }): Promise<CuberouterSession>`
    - `listTokens(accessToken: string): Promise<CuberouterTokenSummary[]>`
    - `createToken(accessToken: string, input: { name: string }): Promise<void>`
    - `getTokenKey(accessToken: string, tokenId: number): Promise<string>`
    - `getSelf(accessToken: string): Promise<CuberouterProfile>`
  - `CuberouterSession = { accessToken: string; userId: string; username: string; displayName: string }`
  - `CuberouterTokenSummary = { id: number; name: string }`
  - `CuberouterProfile = { userId: string; username: string; displayName: string; quota: number }`
  - `CuberouterErrorCode = "two_factor_required" | "service_unavailable" | "rejected"`；错误对象为 `Error & { code: CuberouterErrorCode }`，`rejected` 的 `message` 是服务端原文（服务端已按 `lang` 本地化）。

**背景（已核对 cuberouter 源码）：**
- 响应信封是 `{ success: boolean; message: string; data?: unknown }`，业务错误返回 **HTTP 200 + `success: false`**（`common.ApiErrorI18n`）；鉴权中间件错误返回 401。
- `POST /api/user/register` body `{username, password}`，成功无 data。
- `POST /api/user/login` body `{username, password}`；`data.access_token` 是 JWT，`data.user` 是 `buildSelfUserData`（字段 `id`/`username`/`display_name`/`quota`）。开启 2FA 时返回 `success: true` 且 `data.require_2fa === true`。
- `GET /api/token/` 返回 `data: { page, page_size, total, items: [{ id, name, key(打码) }] }`。
- `POST /api/token/` body 字段是 snake_case：`{ name, expired_time: -1, unlimited_quota: true, remain_quota: 0, model_limits_enabled: false, group: "" }`，**不返回 id 也不返回 key**。
- `POST /api/token/{id}/key` 返回 `data.key` 明文。

- [ ] **Step 1: 写失败的测试**

`App/backend/src/adapters/outbound/cuberouter-client/tests/http-cuberouter-client.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix App/backend exec vitest run src/adapters/outbound/cuberouter-client/tests/http-cuberouter-client.test.ts`
Expected: FAIL — 无法解析 `../index.js`（文件不存在）

- [ ] **Step 3: 写类型**

`App/backend/src/adapters/outbound/cuberouter-client/types.ts`：

```ts
/** Cuberouter client types. */

export type CuberouterErrorCode = "two_factor_required" | "service_unavailable" | "rejected";

export interface CuberouterSession {
  accessToken: string;
  userId: string;
  username: string;
  displayName: string;
}

export interface CuberouterTokenSummary {
  id: number;
  name: string;
}

export interface CuberouterProfile {
  userId: string;
  username: string;
  displayName: string;
  quota: number;
}

export interface CuberouterClient {
  register(input: { username: string; password: string }): Promise<void>;
  login(input: { username: string; password: string }): Promise<CuberouterSession>;
  listTokens(accessToken: string): Promise<CuberouterTokenSummary[]>;
  createToken(accessToken: string, input: { name: string }): Promise<void>;
  getTokenKey(accessToken: string, tokenId: number): Promise<string>;
  getSelf(accessToken: string): Promise<CuberouterProfile>;
}
```

- [ ] **Step 4: 写客户端**

`App/backend/src/adapters/outbound/cuberouter-client/http-cuberouter-client.ts`：

```ts
/** Http cuberouter client module. */
import type { CuberouterClient, CuberouterProfile, CuberouterSession, CuberouterTokenSummary } from "./types.js";

export interface CreateHttpCuberouterClientOptions {
  /** Base url, already trimmed of trailing slashes. */
  baseUrl: string;
  /** Timeout ms. */
  timeoutMs: number;
  /** Fetch impl. */
  fetchImpl?: typeof fetch;
}

interface CuberouterEnvelope {
  success?: boolean;
  message?: string;
  data?: unknown;
}

/** Creates create http cuberouter client. */
export function createHttpCuberouterClient(options: CreateHttpCuberouterClientOptions): CuberouterClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async register(input) {
      await request(fetchImpl, baseUrl, options.timeoutMs, "/api/user/register", {
        method: "POST",
        body: { username: input.username, password: input.password }
      });
    },

    async login(input) {
      const data = await request<Record<string, unknown>>(fetchImpl, baseUrl, options.timeoutMs, "/api/user/login", {
        method: "POST",
        body: { username: input.username, password: input.password }
      });
      if (data.require_2fa === true) {
        throw cuberouterError("two_factor_required", "该账号启用了两步验证，本版本不支持");
      }
      const accessToken = readString(data.access_token);
      const user = asRecord(data.user);
      const userId = readString(user.id) ?? readString(user.userId);
      if (!accessToken || !userId) {
        throw cuberouterError("rejected", "cuberouter 登录响应缺少访问令牌");
      }
      const username = readString(user.username) ?? input.username;
      return {
        accessToken,
        userId,
        username,
        displayName: readString(user.display_name) ?? username
      };
    },

    async listTokens(accessToken) {
      const page = await request<Record<string, unknown>>(fetchImpl, baseUrl, options.timeoutMs, "/api/token/", {
        method: "GET",
        accessToken
      });
      const items = Array.isArray(page.items) ? page.items : [];
      return items.flatMap((item) => {
        const record = asRecord(item);
        const id = typeof record.id === "number" ? record.id : Number.parseInt(String(record.id ?? ""), 10);
        const name = readString(record.name);
        return Number.isFinite(id) && name ? [{ id, name }] : [];
      });
    },

    async createToken(accessToken, input) {
      await request(fetchImpl, baseUrl, options.timeoutMs, "/api/token/", {
        method: "POST",
        accessToken,
        body: {
          name: input.name,
          expired_time: -1,
          unlimited_quota: true,
          remain_quota: 0,
          model_limits_enabled: false,
          group: ""
        }
      });
    },

    async getTokenKey(accessToken, tokenId) {
      const data = await request<Record<string, unknown>>(
        fetchImpl,
        baseUrl,
        options.timeoutMs,
        `/api/token/${tokenId}/key`,
        { method: "POST", accessToken }
      );
      const key = readString(data.key);
      if (!key) throw cuberouterError("rejected", "cuberouter 未返回令牌明文");
      return key;
    },

    async getSelf(accessToken) {
      const data = await request<Record<string, unknown>>(fetchImpl, baseUrl, options.timeoutMs, "/api/user/self", {
        method: "GET",
        accessToken
      });
      const username = readString(data.username) ?? "";
      return {
        userId: readString(data.id) ?? "",
        username,
        displayName: readString(data.display_name) ?? username,
        quota: typeof data.quota === "number" ? data.quota : 0
      } satisfies CuberouterProfile;
    }
  };
}

async function request<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  path: string,
  input: { method: "GET" | "POST"; body?: Record<string, unknown>; accessToken?: string }
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: input.method,
      headers: {
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {})
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw cuberouterError("service_unavailable", "无法连接 cuberouter 服务，请检查服务地址与网络");
  }

  const text = await response.text();
  const envelope = parseEnvelope(text);

  if (!response.ok || envelope.success !== true) {
    throw cuberouterError("rejected", envelope.message || `cuberouter 请求失败（HTTP ${response.status}）`);
  }

  return (envelope.data ?? {}) as T;
}

function parseEnvelope(text: string): CuberouterEnvelope {
  if (!text) return {};
  try {
    return JSON.parse(text) as CuberouterEnvelope;
  } catch {
    return {};
  }
}

function cuberouterError(code: CuberouterErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}
```

记得在文件顶部 import 里加上 `CuberouterErrorCode`（`import type { CuberouterClient, CuberouterErrorCode, ... }`）。

- [ ] **Step 5: 写 barrel**

`App/backend/src/adapters/outbound/cuberouter-client/index.ts`：

```ts
/** Cuberouter client module. */
export * from "./http-cuberouter-client.js";
export * from "./types.js";
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm --prefix App/backend exec vitest run src/adapters/outbound/cuberouter-client/tests/http-cuberouter-client.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 7: 提交**

```bash
git add App/backend/src/adapters/outbound/cuberouter-client
git commit -m "feat(auth): add cuberouter http client"
```

---

### Task 3: cuberouter 账号编排服务

**Files:**
- Create: `App/backend/src/services/cuberouter-account-service.ts`
- Test: `App/backend/src/services/tests/cuberouter-account-service.test.ts`
- Modify: `App/backend/src/infrastructure/app-state-store/repositories/account-session-repo.ts`（读取侧要能返回 `cuberouter` 身份，见 Step 5）
- Test: `App/backend/src/infrastructure/app-state-store/tests/account-session-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CuberouterAuthResult`/`CuberouterProvisioning`；Task 2 的 `CuberouterClient`、`CuberouterErrorCode`。
- Produces:
  - `createCuberouterAccountService(options: CreateCuberouterAccountServiceOptions): CuberouterAccountService`
  - `CuberouterAccountService`：
    - `register(input: { username: string; password: string }): Promise<CuberouterAuthResult>`
    - `login(input: { username: string; password: string }): Promise<CuberouterAuthResult>`
    - `logout(): Promise<{ ok: true }>`
  - `CreateCuberouterAccountServiceOptions = { client: CuberouterClient; accountSessionRepository: AccountSessionRepository; baseUrl: string; model: string }`
  - `MEMORY_DESKTOP_TOKEN_NAME = "memmy-desktop"`
  - `toCuberouterAccountUuid(userId: string): string`（返回 `cuberouter:<userId>`）

**行为要点：**
- `register` = `client.register` 成功后走 `completeLogin`。
- `completeLogin(username, password)`：`client.login` → `ensureApiKey` → 写会话 → 返回 `{ session, provisioning: { apiKey, apiBase: `${baseUrl}/v1`, model } }`。
- `ensureApiKey(accessToken)`：先 `listTokens` 找 `memmy-desktop`，命中就 `getTokenKey`；未命中则 `createToken` 后**重新 list** 取 id（cuberouter 建 token 不返回 id），再 `getTokenKey`；仍找不到抛 `rejected`。
- 会话写入：`uuid = cuberouter:<userId>`、`cloudUuid = accessToken`（JWT 落加密 secret_store）、`authChannel = "cuberouter"`、`profile.identityProvider = "cuberouter"`、`nickname = displayName`、`email/phoneNumber/planType/region = null`、`hasFinishedGuide = null`、`registeredAt = null`。
- `logout()` 只清本地会话，不调 cuberouter（spec D9）。

- [ ] **Step 1: 写失败的测试**

`App/backend/src/services/tests/cuberouter-account-service.test.ts`：

```ts
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
    const client = fakeClient();
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
      code: "rejected"
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix App/backend exec vitest run src/services/tests/cuberouter-account-service.test.ts`
Expected: FAIL — 无法解析 `../cuberouter-account-service.js`

- [ ] **Step 3: 实现服务**

`App/backend/src/services/cuberouter-account-service.ts`：

```ts
/** Cuberouter account service module. */
import type { CuberouterAuthResult } from "@memmy/local-api-contracts";
import type { CuberouterClient } from "../adapters/outbound/cuberouter-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";

/** Fixed token name used as the idempotency key for desktop provisioning. */
export const MEMORY_DESKTOP_TOKEN_NAME = "memmy-desktop";

export interface CuberouterAccountService {
  register(input: { username: string; password: string }): Promise<CuberouterAuthResult>;
  login(input: { username: string; password: string }): Promise<CuberouterAuthResult>;
  logout(): Promise<{ ok: true }>;
}

export interface CreateCuberouterAccountServiceOptions {
  /** cuberouter REST client. */
  client: CuberouterClient;
  /** Account session repository. */
  accountSessionRepository: AccountSessionRepository;
  /** cuberouter base URL without trailing slash; the model API base appends /v1. */
  baseUrl: string;
  /** Fixed model provisioned for the desktop. */
  model: string;
}

/** Handles to cuberouter account uuid. */
export function toCuberouterAccountUuid(userId: string): string {
  return `cuberouter:${userId}`;
}

/** Creates create cuberouter account service. */
export function createCuberouterAccountService(
  options: CreateCuberouterAccountServiceOptions
): CuberouterAccountService {
  const provisioningApiBase = `${options.baseUrl.replace(/\/+$/, "")}/v1`;

  async function completeLogin(username: string, password: string): Promise<CuberouterAuthResult> {
    const session = await options.client.login({ username, password });
    const apiKey = await ensureApiKey(session.accessToken);
    const projection = options.accountSessionRepository.upsert({
      uuid: toCuberouterAccountUuid(session.userId),
      cloudUuid: session.accessToken,
      // 不传 isNewUser：仓库会按"是否已有该 user_id 的行"自行判定，
      // 否则老用户每次登录都会被当成新用户重新走一遍 onboarding。
      authChannel: "cuberouter",
      profile: {
        userId: session.userId,
        email: null,
        phoneNumber: null,
        nickname: session.displayName,
        avatarUrl: null,
        planType: null,
        hasFinishedGuide: null,
        region: null,
        registeredAt: null,
        identityProvider: "cuberouter",
        rawProfile: {
          username: session.username,
          displayName: session.displayName
        }
      }
    });

    return {
      session: projection,
      provisioning: { apiKey, apiBase: provisioningApiBase, model: options.model }
    };
  }

  async function ensureApiKey(accessToken: string): Promise<string> {
    const existing = await findToken(accessToken);
    if (existing) {
      return options.client.getTokenKey(accessToken, existing.id);
    }

    await options.client.createToken(accessToken, { name: MEMORY_DESKTOP_TOKEN_NAME });
    // cuberouter 建 token 不返回 id，必须重新列一次才能拿到。
    const created = await findToken(accessToken);
    if (!created) {
      throw Object.assign(new Error("cuberouter 未返回新建的令牌"), { code: "rejected" as const });
    }
    return options.client.getTokenKey(accessToken, created.id);
  }

  async function findToken(accessToken: string) {
    const tokens = await options.client.listTokens(accessToken);
    return tokens.find((token) => token.name === MEMORY_DESKTOP_TOKEN_NAME) ?? null;
  }

  return {
    async register(input) {
      await options.client.register({ username: input.username, password: input.password });
      return completeLogin(input.username, input.password);
    },

    async login(input) {
      return completeLogin(input.username, input.password);
    },

    async logout() {
      options.accountSessionRepository.clear();
      return { ok: true };
    }
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix App/backend exec vitest run src/services/tests/cuberouter-account-service.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 让会话仓库读得出 cuberouter 身份**

现在写入是对的、读出来会丢身份：`resolveExplicitAccountAuthChannel` 硬编码只认 `"email" | "phone"`，`toProfileView` 也不带 `identityProvider`。三处改动：

1) `account-session-repo.ts` 的 `resolveExplicitAccountAuthChannel`：

```ts
function resolveExplicitAccountAuthChannel(row: AccountSessionRow | null): AccountChannel | null {
  if (!row?.raw_profile_json) return null;
  const value = parseRawProfile(row.raw_profile_json)?.[LOCAL_AUTH_CHANNEL_FIELD];
  const parsed = AccountChannelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
```

（import 补 `AccountChannelSchema`）

2) 同文件 `toProfileView` 的返回对象加一行：

```ts
    identityProvider: resolveAccountAuthChannel(row) === "cuberouter" ? "cuberouter" : "memmy_cloud",
```

3) 同文件 `upsert` 里返回的那个 `AccountProfileViewSchema.parse({...})` 也要带上（否则 `.default("memmy_cloud")` 会把它写成云身份）：

```ts
          identityProvider: input.profile.identityProvider,
```

- [ ] **Step 6: 给仓库加一条回归测试**

`App/backend/src/infrastructure/app-state-store/tests/account-session-repo.test.ts` 追加：

```ts
  it("round-trips a cuberouter identity and channel", () => {
    const store = createStore();
    store.repositories.accountSession.upsert({
      uuid: "cuberouter:7",
      cloudUuid: "jwt-1",
      authChannel: "cuberouter",
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
        identityProvider: "cuberouter",
        rawProfile: {}
      }
    });

    expect(store.repositories.accountSession.getAuthChannel()).toBe("cuberouter");
    expect(store.repositories.accountSession.get().profile.identityProvider).toBe("cuberouter");
    expect(store.repositories.accountSession.getCloudUuid()).toBe("jwt-1");
  });
```

（`createStore()` 用文件里既有的仓库构造辅助；若该文件用的是别的名字，沿用它的写法）

Run: `npm --prefix App/backend exec vitest run src/infrastructure/app-state-store/tests/account-session-repo.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add App/backend/src/services/cuberouter-account-service.ts App/backend/src/services/tests/cuberouter-account-service.test.ts App/backend/src/infrastructure/app-state-store/repositories/account-session-repo.ts App/backend/src/infrastructure/app-state-store/tests/account-session-repo.test.ts
git commit -m "feat(auth): add cuberouter account provisioning service"
```

---

### Task 4: 路由切换与后端装配

**Files:**
- Modify: `App/backend/src/adapters/inbound/local-api/routes/account.ts`
- Modify: `App/backend/src/services/account-service.ts`（删除 `sendCode`/`verifyCode`/`assertExpectedAccountChannel`，invitation 在 cuberouter 身份下返回禁用）
- Modify: `App/backend/src/services/index.ts`（构造并暴露 `cuberouterAccount`）
- Modify: `App/backend/src/index.ts`（解析配置、建客户端、传进服务）
- Test: `App/backend/src/adapters/inbound/local-api/tests/account-routes.test.ts`（既有文件，改造受影响用例）
- Test: `App/backend/src/services/tests/account-service.test.ts`（既有文件，改造受影响用例）

**Interfaces:**
- Consumes: Task 1 的 `CuberouterAuthInputSchema`/`CuberouterAuthResultSchema`、`resolveCuberouterClientConfig`；Task 2 的 `createHttpCuberouterClient`；Task 3 的 `createCuberouterAccountService`。
- Produces:
  - `POST /api/account/register` → `CuberouterAuthResult`
  - `POST /api/account/login` → `CuberouterAuthResult`
  - `RegisterAccountRoutesOptions` 增加 `cuberouterAccount: CuberouterAccountService`
  - `createBackendServices` 的 options 增加 `cuberouterClient: CuberouterClient`，返回值增加 `cuberouterAccount`

- [ ] **Step 1: 先看既有路由测试是怎么断言 send-code/verify-code 的**

Run: `grep -n "send-code\|verify-code" -A 12 App/backend/src/adapters/inbound/local-api/tests/account-routes.test.ts | head -60`

把这两个端点的用例改成新端点的用例（下面 Step 4 给断言样例）。若测试文件里有只服务于验证码的 mock（例如 cloudClient 的 `sendEmailCode`/`login` 桩），改成 `CuberouterAccountService` 的桩。

- [ ] **Step 2: 运行既有测试确认当前是绿的（改动前的基线）**

Run: `npm --prefix App/backend exec vitest run src/adapters/inbound/local-api/tests/account-routes.test.ts`
Expected: PASS（记录基线）

- [ ] **Step 3: 改路由**

`App/backend/src/adapters/inbound/local-api/routes/account.ts`：

1) import 改成：

```ts
import {
  AccountInvitationViewSchema,
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  AvatarOptionSchema,
  CuberouterAuthInputSchema,
  CuberouterAuthResultSchema,
  OkResponseSchema,
  SetAvatarInputSchema,
  UpdateAccountProfileInputSchema
} from "@memmy/local-api-contracts";
import type { CuberouterAccountService } from "../../../../services/cuberouter-account-service.js";
```

（移除 `AccountLoginResultViewSchema`、`SendCodeInputSchema`、`SendCodeResponseSchema`、`VerifyCodeInputSchema`）

2) `RegisterAccountRoutesOptions` 增加一行：

```ts
  cuberouterAccount: CuberouterAccountService;
```

3) 把 `send-code` 与 `verify-code` 两个 `app.post(...)` 块整体替换为：

```ts
  app.post(
    "/api/account/register",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = CuberouterAuthInputSchema.parse(request.body);
      const response = CuberouterAuthResultSchema.parse(await options.cuberouterAccount.register(input));
      return reply.send(response);
    })
  );

  app.post(
    "/api/account/login",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = CuberouterAuthInputSchema.parse(request.body);
      const response = CuberouterAuthResultSchema.parse(await options.cuberouterAccount.login(input));
      return reply.send(response);
    })
  );
```

- [ ] **Step 4: 更新路由测试**

`account-routes.test.ts` 用的是 `createServer(overrides)`（约 188 行，顶层 `...overrides` 合并进 services）与 `injectJson(method, url, payload)`（约 173 行）。做两件事：

1) 删掉 `createServer` 默认桩里 `account` 的 `sendCode`/`verifyCode` 两个方法（接口上已经没有了），并在 `appConfig` 之后加一个默认桩：

```ts
    cuberouterAccount: {
      async register() {
        throw new Error("register not used");
      },
      async login() {
        throw new Error("login not used");
      },
      async logout() {
        return { ok: true };
      }
    },
```

2) 在 `describe("account local api routes", ...)` 里新增用例：

```ts
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

  it("rejects credentials that violate the shared schema", async () => {
    app = createServer();

    const response = await injectJson("POST", "/api/account/login", {
      username: "alice",
      password: "short"
    });

    expect(response.statusCode).toBe(400);
  });
```

- [ ] **Step 5: 瘦身 account-service**

`App/backend/src/services/account-service.ts`：
- 删除 `sendCode`、`verifyCode` 及其在 `AccountService` 接口里的声明
- 删除 `assertExpectedAccountChannel` 函数、`CreateAccountServiceOptions.accountChannel` 字段，以及 `SendCodeInput`/`SendCodeResponse`/`VerifyCodeInput`/`AccountLoginResultView` 相关 import
- `getInvitation()` 改为：当前会话 `getAuthChannel() === "cuberouter"` 时直接返回

```ts
      return AccountInvitationViewSchema.parse({
        enabled: false,
        invitationCode: "",
        usedSlotsToday: 0,
        dailyLimitReached: false
      });
```

（保留云端分支给 `identityProvider === "memmy_cloud"` 的老会话）

- [ ] **Step 6: 让启动同步接受 cuberouter 身份（否则每次重启都会掉登录）**

`App/backend/src/services/runtime-config-sync-service.ts` 的 `clearMismatchedActiveSession` 在 `getAuthChannel()` 与 `options.accountChannel` 不一致时会**清掉当前会话**，还会顺带调 `clearAccountModelProjectionFromMemmyConfig({ownerAccountId})`。cuberouter 会话的 channel 是 `"cuberouter"`，桌面包传下来的是 `"phone"`/`"email"`，于是每次启动都会清登录——这个功能等于不成立。改法：

```ts
  const activeChannel = options.appStateStore.repositories.accountSession.getAuthChannel();
  if (activeChannel === "cuberouter" || activeChannel === options.accountChannel) {
    return null;
  }
```

（替换原先那句 `if (options.appStateStore.repositories.accountSession.getAuthChannel() === options.accountChannel) { return null; }`）

在 `App/backend/src/services/tests/runtime-config-sync-service.test.ts` 追加回归用例：`accountChannel: "phone"`，会话写入 `authChannel: "cuberouter"`，断言 `syncRuntimeConfigWithAppState` 之后 `accountSession.get().authenticated` 仍为 `true`，且结果 `reason` 不是 `"account_session_channel_mismatch"`。

Run: `npm --prefix App/backend exec vitest run src/services/tests/runtime-config-sync-service.test.ts`
Expected: PASS

- [ ] **Step 7: 装配**

`App/backend/src/services/index.ts`：
- import：`import { createCuberouterAccountService } from "./cuberouter-account-service.js";` 和 `import type { CuberouterClient } from "../adapters/outbound/cuberouter-client/index.js";`
- options 类型里 `accountChannel?: AccountChannel;` 换成 `cuberouterClient: CuberouterClient;`（同时删掉 `AccountChannel` import）
- 返回值里加：

```ts
    cuberouterAccount: createCuberouterAccountService({
      client: options.cuberouterClient,
      accountSessionRepository: options.appStateStore.repositories.accountSession,
      baseUrl: cuberouterConfig.baseUrl,
      model: cuberouterConfig.model
    }),
```

把 `cuberouterConfig` 从 options 传入（见下一步）：options 里加 `cuberouterConfig: CuberouterClientConfig;`
- 原先传给 `createAccountService` 的 `accountChannel: options.accountChannel` 删掉

`App/backend/src/index.ts`（在 `const cloudConfig = resolveCloudClientConfig(process.env);` 附近）：

```ts
    const cuberouterConfig = resolveCuberouterClientConfig(process.env);
    const cuberouterClient = createHttpCuberouterClient({
      baseUrl: cuberouterConfig.baseUrl,
      timeoutMs: cuberouterConfig.timeoutMs
    });
```

并在 `createBackendServices({...})` 的调用里加上 `cuberouterConfig,` 与 `cuberouterClient,`；import 补 `resolveCuberouterClientConfig`、`createHttpCuberouterClient`。

- [ ] **Step 8: 全量跑后端测试**

Run: `npm --prefix App/backend exec vitest run src/adapters/inbound/local-api/tests/account-routes.test.ts src/services/tests/account-service.test.ts`
Expected: PASS

Run: `npm --prefix App/backend run typecheck`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add App/backend/src/adapters/inbound/local-api/routes/account.ts App/backend/src/adapters/inbound/local-api/tests/account-routes.test.ts App/backend/src/services/index.ts App/backend/src/services/account-service.ts App/backend/src/services/tests/account-service.test.ts App/backend/src/services/runtime-config-sync-service.ts App/backend/src/services/tests/runtime-config-sync-service.test.ts App/backend/src/index.ts
git commit -m "feat(auth): switch account routes to cuberouter register/login"
```

---

### Task 5: 桌面账号客户端与认证表单

**Files:**
- Modify: `App/frontend/desktop/src/api/account-client.ts`
- Create: `App/frontend/desktop/src/components/auth-credentials-form.tsx`
- Create: `App/frontend/desktop/src/components/use-account-auth.ts`
- Delete: `App/frontend/desktop/src/components/auth-code-form.tsx`、`App/frontend/desktop/src/components/use-verification-code-auth.ts`
- Modify: `App/frontend/desktop/src/i18n/messages.ts`（`zhCNMessages` 与 `enUSMessages` 各加一组 `account.*` key）
- Test: `App/frontend/desktop/src/components/tests/use-account-auth.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CuberouterAuthInput`/`CuberouterAuthResult`。
- Produces:
  - `AccountClient.register(input: CuberouterAuthInput): Promise<CuberouterAuthResult>`
  - `AccountClient.login(input: CuberouterAuthInput): Promise<CuberouterAuthResult>`（替换 `sendCode`/`verifyCode`）
  - `validateCredentials(input: { username: string; password: string; confirmPassword?: string }): { ok: true; username: string; password: string } | { ok: false; reason: "username" | "password" | "confirm" }`
  - `useAccountAuth(): { pending: boolean; feedback: AuthFeedback | null; register(username, password): Promise<CuberouterAuthResult | null>; login(username, password): Promise<CuberouterAuthResult | null>; clearFeedback(): void }`
  - `AuthCredentialsForm`（props 见 Step 5）

**密码规则（来自 cuberouter 的 `validate:"min=8,max=20,passwordStrength"`）：** 8–20 位，且同时含大写、小写、数字。前端按同一规则预校验。

- [ ] **Step 1: 写失败的测试**

`App/frontend/desktop/src/components/tests/use-account-auth.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { validateCredentials } from "../use-account-auth.js";

describe("validateCredentials", () => {
  it("accepts an 8-20 char password with upper, lower and digit", () => {
    expect(validateCredentials({ username: "alice", password: "Passw0rd1" })).toEqual({
      ok: true,
      username: "alice",
      password: "Passw0rd1"
    });
  });

  it("rejects a missing username", () => {
    expect(validateCredentials({ username: "   ", password: "Passw0rd1" })).toEqual({
      ok: false,
      reason: "username"
    });
  });

  it("rejects passwords shorter than 8 or longer than 20", () => {
    expect(validateCredentials({ username: "alice", password: "Pa0ss" })).toEqual({ ok: false, reason: "password" });
    expect(validateCredentials({ username: "alice", password: `Pa0${"x".repeat(20)}` })).toEqual({
      ok: false,
      reason: "password"
    });
  });

  it("rejects passwords missing an upper case, lower case or digit", () => {
    expect(validateCredentials({ username: "alice", password: "passw0rdd" })).toEqual({ ok: false, reason: "password" });
    expect(validateCredentials({ username: "alice", password: "PASSW0RDD" })).toEqual({ ok: false, reason: "password" });
    expect(validateCredentials({ username: "alice", password: "Passwordd" })).toEqual({ ok: false, reason: "password" });
  });

  it("rejects mismatched confirmation", () => {
    expect(
      validateCredentials({ username: "alice", password: "Passw0rd1", confirmPassword: "Passw0rd2" })
    ).toEqual({ ok: false, reason: "confirm" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix App/frontend/desktop exec vitest run src/components/tests/use-account-auth.test.ts`
Expected: FAIL — 无法解析 `../use-account-auth.js`

- [ ] **Step 3: 改客户端**

`App/frontend/desktop/src/api/account-client.ts`：
- import 改为 `CuberouterAuthInputSchema`、`CuberouterAuthResultSchema`、`type CuberouterAuthInput`、`type CuberouterAuthResult`（移除 `SendCode*`、`VerifyCodeInput`、`AccountLoginResultView`）
- 接口里 `sendCode`/`verifyCode` 换成：

```ts
  register(input: CuberouterAuthInput): Promise<CuberouterAuthResult>;
  login(input: CuberouterAuthInput): Promise<CuberouterAuthResult>;
```

- 实现：

```ts
    async register(input) {
      return requestJson({
        config,
        path: "/api/account/register",
        schema: CuberouterAuthResultSchema,
        body: CuberouterAuthInputSchema.parse(input)
      });
    },

    async login(input) {
      return requestJson({
        config,
        path: "/api/account/login",
        schema: CuberouterAuthResultSchema,
        body: CuberouterAuthInputSchema.parse(input)
      });
    },
```

- 删除 `AccountIdentifier`、`AccountCodeValidationReason`、`AccountCodeValidationInput`、`AccountCodeValidationResult`、`resolveAccountIdentifier`、`validateAccountCodeInput`（连同它们的 import）。用 `grep -rn "validateAccountCodeInput\|resolveAccountIdentifier" App/frontend/desktop/src` 找出残留引用并一并改掉。

- [ ] **Step 4: 写 hook**

`App/frontend/desktop/src/components/use-account-auth.ts`：

```ts
/** Account authentication module. */
import type { CuberouterAuthResult } from "@memmy/local-api-contracts";
import { useCallback, useState } from "react";
import { useApiClients } from "../app/providers.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface AuthFeedback {
  text: string;
  tone: "error" | "success";
}

export type CredentialsValidationResult =
  | { ok: true; username: string; password: string }
  | { ok: false; reason: "username" | "password" | "confirm" };

/** Validates credentials against cuberouter's User rules (8-20 chars, upper + lower + digit). */
export function validateCredentials(input: {
  username: string;
  password: string;
  confirmPassword?: string;
}): CredentialsValidationResult {
  const username = input.username.trim();
  if (!username || username.length > 50) {
    return { ok: false, reason: "username" };
  }

  const password = input.password;
  if (password.length < 8 || password.length > 20) {
    return { ok: false, reason: "password" };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, reason: "password" };
  }

  if (input.confirmPassword !== undefined && input.confirmPassword !== password) {
    return { ok: false, reason: "confirm" };
  }

  return { ok: true, username, password };
}

const validationMessageKeys: Record<"username" | "password" | "confirm", MessageKey> = {
  username: "account.error.username",
  password: "account.error.password",
  confirm: "account.error.confirm"
};

export interface UseAccountAuthResult {
  pending: boolean;
  feedback: AuthFeedback | null;
  register(username: string, password: string, confirmPassword?: string): Promise<CuberouterAuthResult | null>;
  login(username: string, password: string, confirmPassword?: string): Promise<CuberouterAuthResult | null>;
  clearFeedback(): void;
  setFailure(feedback: AuthFeedback): void;
}

export function useAccountAuth(): UseAccountAuthResult {
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<AuthFeedback | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  const authenticate = useCallback(
    async (
      mode: "register" | "login",
      username: string,
      password: string,
      confirmPassword?: string
    ): Promise<CuberouterAuthResult | null> => {
      const validation = validateCredentials({ username, password, confirmPassword });
      if (!validation.ok) {
        setFeedback({ text: t(validationMessageKeys[validation.reason]), tone: "error" });
        return null;
      }

      if (!clients || pending) {
        return null;
      }

      setPending(true);
      setFeedback(null);
      try {
        const credentials = { username: validation.username, password: validation.password };
        return mode === "register"
          ? await clients.account.register(credentials)
          : await clients.account.login(credentials);
      } catch (error) {
        setFeedback({
          text: error instanceof Error && error.message ? error.message : t("account.error.requestFailed"),
          tone: "error"
        });
        return null;
      } finally {
        setPending(false);
      }
    },
    [clients, pending, t]
  );

  return {
    pending,
    feedback,
    register: (username, password, confirmPassword) => authenticate("register", username, password, confirmPassword),
    login: (username, password, confirmPassword) => authenticate("login", username, password, confirmPassword),
    clearFeedback,
    setFailure: setFeedback
  };
}
```

- [ ] **Step 5: 写表单组件**

`App/frontend/desktop/src/components/auth-credentials-form.tsx`：结构照 `auth-code-form.tsx`（同一个外层 `space-y-3.5` + 那个 terms 段落），把 identifier/code 两个 input 换成 username + password（注册模式再加 confirm），两个主按钮：

```tsx
export interface AuthCredentialsFormProps {
  username: string;
  password: string;
  confirmPassword?: string;
  mode: "register" | "login";
  feedback?: { text: string; tone: "error" | "success" } | null;
  disabled?: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange?: (value: string) => void;
  onSubmit: () => void;
  onModeChange: (mode: "register" | "login") => void;
  onOpenTerms?: () => void;
  onOpenDataAgreement?: () => void;
}
```

实现（样式类名与 `auth-code-form.tsx` 保持一致，terms 段落原样搬过来）：

```tsx
/** Auth credentials form module. */
import { useTranslation } from "../i18n/use-translation.js";

/** Contract for auth credentials form props. */
export interface AuthCredentialsFormProps {
  mode: "register" | "login";
  username: string;
  password: string;
  /** Only rendered in register mode. */
  confirmPassword?: string;
  feedback?: { text: string; tone: "error" | "success" } | null;
  disabled?: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange?: (value: string) => void;
  onSubmit: () => void;
  onModeChange: (mode: "register" | "login") => void;
  onOpenTerms?: () => void;
  onOpenDataAgreement?: () => void;
}

const inputClassName = "auth-code-form-input w-full px-5 py-3 border rounded-input text-sm bg-canvas-oat/30 focus:outline-none";

/** Handles auth credentials form. */
export function AuthCredentialsForm(props: AuthCredentialsFormProps) {
  const { t } = useTranslation();
  const errorFeedback = props.feedback?.tone === "error" ? props.feedback : null;

  function submitOnEnter(event: { key: string }) {
    if (event.key === "Enter" && !props.disabled) {
      props.onSubmit();
    }
  }

  return (
    <div className="space-y-3.5">
      <input
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={50}
        placeholder={t("account.usernamePlaceholder")}
        value={props.username}
        aria-invalid={Boolean(errorFeedback)}
        onChange={(event) => props.onUsernameChange(event.target.value)}
        onKeyDown={submitOnEnter}
        className={inputClassName}
      />
      <input
        type="password"
        autoComplete={props.mode === "register" ? "new-password" : "current-password"}
        placeholder={t("account.passwordPlaceholder")}
        value={props.password}
        aria-invalid={Boolean(errorFeedback)}
        onChange={(event) => props.onPasswordChange(event.target.value)}
        onKeyDown={submitOnEnter}
        className={inputClassName}
      />
      {props.mode === "register" ? (
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t("account.confirmPasswordPlaceholder")}
          value={props.confirmPassword ?? ""}
          aria-invalid={Boolean(errorFeedback)}
          onChange={(event) => props.onConfirmPasswordChange?.(event.target.value)}
          onKeyDown={submitOnEnter}
          className={inputClassName}
        />
      ) : null}

      {errorFeedback ? (
        <p
          role="alert"
          aria-live="polite"
          title={errorFeedback.text}
          className="text-left text-[12px] font-normal leading-5 text-status-error"
        >
          {errorFeedback.text}
        </p>
      ) : null}

      <p className="auth-code-form-terms text-[10px] text-text-ink/50 text-left leading-snug">
        {t("login.termsPrefix")}
        <button type="button" onClick={props.onOpenTerms} className="text-action-sky hover:underline cursor-pointer">
          {t("login.termsLink")}
        </button>
        {t("login.termsConnector")}
        <button type="button" onClick={props.onOpenDataAgreement} className="text-action-sky hover:underline cursor-pointer">
          {t("login.dataAgreementLink")}
        </button>
        {t("login.termsSuffix")}
      </p>

      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onSubmit}
        className="w-full py-3 bg-action-sky text-white font-semibold rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer shadow-md hover:shadow-lg active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {props.mode === "register" ? t("account.register") : t("account.login")}
      </button>

      <button
        type="button"
        disabled={props.disabled}
        onClick={() => props.onModeChange(props.mode === "register" ? "login" : "register")}
        className="w-full text-center text-xs text-text-ink/60 hover:text-action-sky transition-colors cursor-pointer disabled:opacity-40"
      >
        {props.mode === "register" ? t("account.switchToLogin") : t("account.switchToRegister")}
      </button>
    </div>
  );
}
```

- [ ] **Step 6: 加 i18n key**

`App/frontend/desktop/src/i18n/messages.ts` 的 `zhCNMessages` 加：

```ts
  "account.usernamePlaceholder": "用户名",
  "account.passwordPlaceholder": "密码",
  "account.confirmPasswordPlaceholder": "确认密码",
  "account.register": "注册并开始使用",
  "account.login": "登录",
  "account.switchToLogin": "已有账号？去登录",
  "account.switchToRegister": "没有账号？去注册",
  "account.error.username": "请输入用户名（不超过 50 个字符）",
  "account.error.password": "密码需 8-20 位，且同时包含大写字母、小写字母和数字",
  "account.error.confirm": "两次输入的密码不一致",
  "account.error.requestFailed": "请求失败，请稍后重试",
  "account.error.provisionFailed": "模型配置写入失败，请重试",
  "account.warning.modelUnavailable": "模型暂时不可用：{reason}",
```

`enUSMessages` 加同名 key 的英文文案（`Record<keyof typeof zhCNMessages, string>` 会强制要求补齐）：

```ts
  "account.usernamePlaceholder": "Username",
  "account.passwordPlaceholder": "Password",
  "account.confirmPasswordPlaceholder": "Confirm password",
  "account.register": "Register and start",
  "account.login": "Log in",
  "account.switchToLogin": "Already registered? Log in",
  "account.switchToRegister": "No account yet? Register",
  "account.error.username": "Enter a username (up to 50 characters)",
  "account.error.password": "Password must be 8-20 characters with upper case, lower case and a digit",
  "account.error.confirm": "The two passwords do not match",
  "account.error.requestFailed": "Request failed, please try again",
  "account.error.provisionFailed": "Failed to write the model config, please retry",
  "account.warning.modelUnavailable": "Model unavailable: {reason}",
```

- [ ] **Step 7: 删旧组件**

```bash
git rm App/frontend/desktop/src/components/auth-code-form.tsx App/frontend/desktop/src/components/use-verification-code-auth.ts
```

`welcome-page.tsx`、`login-page.tsx`、`token-detail-page.tsx` 此刻会编译失败——Task 6 修它们。本步只保证新 hook 的测试通过。

- [ ] **Step 8: 跑测试与类型检查**

Run: `npm --prefix App/frontend/desktop exec vitest run src/components/tests/use-account-auth.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 9: 提交**

```bash
git add -A App/frontend/desktop/src/api/account-client.ts App/frontend/desktop/src/components App/frontend/desktop/src/i18n/messages.ts
git commit -m "feat(auth): replace verification-code form with cuberouter credentials form"
```

---

### Task 6: 模型供给与注册/登录续接

**Files:**
- Create: `App/frontend/desktop/src/state/model-provisioning.ts`
- Create: `App/frontend/desktop/src/components/account-auth-panel.tsx`
- Modify: `App/frontend/desktop/src/pages/welcome-page.tsx`、`App/frontend/desktop/src/pages/login-page.tsx`
- Test: `App/frontend/desktop/src/state/tests/model-provisioning.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `useAccountAuth`/`AuthCredentialsForm`；Task 3 的 `CuberouterAuthResult.provisioning`；既有 `upsertByokPreset`/`assignCatalogPreset`/`modelConfigInput`/`createModelWorkspace`（`state/model-workspace.ts`）、`persistLoginModeSelection`（`app/login-mode.ts`）。
- Produces:
  - `provisionByokModel(input: { configClient: ConfigClient; endpoint: { apiBase: string; protocol: ModelEndpointProtocol; apiKey: string }; model: string; capabilities: ModelCapability[]; assign: ModelCapability[] }): Promise<void>`
  - `AccountAuthPanel`（页面内共用面板，自带续接逻辑）

**关键约束：** `provisionByokModel` 的调用方各自决定能力集——注册链路传 `capabilities: ["agent","memory_summary","memory_evolution"]` 且 `assign` 同这三项；`api-key-page.tsx` 保持 `["agent"]` + `assign: ["agent"]`，其 embedding 分支不动。

- [ ] **Step 1: 写失败的测试**

`App/frontend/desktop/src/state/tests/model-provisioning.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createModelWorkspace } from "../model-workspace.js";
import { provisionByokModel } from "../model-provisioning.js";

function configClientWithCalls() {
  const saved: any[] = [];
  const client = {
    getModelConfig: vi.fn(async () => ({
      providers: [],
      modelAssignments: createModelWorkspace(null).catalog.modelAssignments,
      configRevision: "rev-1"
    })),
    saveModelCatalog: vi.fn(async (input: any) => {
      saved.push(input);
      return { providers: [], modelAssignments: input.modelAssignments, configRevision: "rev-2" };
    })
  };
  return { client: client as any, saved };
}

describe("provisionByokModel", () => {
  it("writes one openai provider with the cuberouter endpoint and assigns three capabilities", async () => {
    const { client, saved } = configClientWithCalls();

    await provisionByokModel({
      configClient: client,
      endpoint: { apiBase: "http://127.0.0.1:3000/v1", protocol: "openai-chat-completions", apiKey: "sk-plain" },
      model: "deepseek-flash",
      capabilities: ["agent", "memory_summary", "memory_evolution"],
      assign: ["agent", "memory_summary", "memory_evolution"]
    });

    expect(saved).toHaveLength(1);
    const provider = saved[0].providers.find((item: any) => item.provider === "openai");
    expect(provider.endpoints[0].apiBase).toBe("http://127.0.0.1:3000/v1");
    expect(provider.endpoints[0].apiKey).toBe("sk-plain");
    expect(provider.models[0].model).toBe("deepseek-flash");
    expect(provider.models[0].capabilities).toEqual(
      expect.arrayContaining(["agent", "memory_summary", "memory_evolution"])
    );
    const byok = saved[0].modelAssignments.byok;
    const presetId = provider.models[0].presetId;
    expect(byok.agent.default).toBe(presetId);
    expect(byok.agent.candidates).toContain(presetId);
    expect(byok.memorySummary).toBe(presetId);
    expect(byok.memoryEvolution).toBe(presetId);
    expect(byok.embedding).toBeNull();
  });

  it("retries once when the catalog revision is stale", async () => {
    const { client, saved } = configClientWithCalls();
    client.saveModelCatalog.mockRejectedValueOnce(
      Object.assign(new Error("stale"), { code: "model_config_changed" })
    );

    await provisionByokModel({
      configClient: client,
      endpoint: { apiBase: "http://127.0.0.1:3000/v1", protocol: "openai-chat-completions", apiKey: "sk-plain" },
      model: "deepseek-flash",
      capabilities: ["agent", "memory_summary", "memory_evolution"],
      assign: ["agent", "memory_summary", "memory_evolution"]
    });

    expect(client.saveModelCatalog).toHaveBeenCalledTimes(2);
    expect(saved).toHaveLength(1);
  });
});
```

（若 `emptyCatalog` 未从 `model-workspace.js` 导出，改用 `createModelWorkspace(null).catalog` 取 assignments。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix App/frontend/desktop exec vitest run src/state/tests/model-provisioning.test.ts`
Expected: FAIL — 无法解析 `../model-provisioning.js`

- [ ] **Step 3: 实现 provisionByokModel**

`App/frontend/desktop/src/state/model-provisioning.ts`：

```ts
/** Model provisioning module. */
import type { ModelCapability, ModelEndpointProtocol } from "@memmy/local-api-contracts";
import type { ConfigClient } from "../api/config-client.js";
import {
  assignCatalogPreset,
  createModelWorkspace,
  modelConfigInput,
  upsertByokPreset
} from "./model-workspace.js";

const PROVIDER_ID = "openai";

export interface ProvisionByokModelInput {
  configClient: ConfigClient;
  endpoint: { apiBase: string; protocol: ModelEndpointProtocol; apiKey: string };
  model: string;
  /** Capabilities written into the preset. */
  capabilities: ModelCapability[];
  /** Assignment slots pointed at the preset. */
  assign: ModelCapability[];
}

/**
 * Writes one BYOK provider/endpoint/preset for the given key and model, then
 * points the requested assignment slots at it.
 *
 * @param input the endpoint, model, capabilities and assignment slots.
 */
export async function provisionByokModel(input: ProvisionByokModelInput): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await input.configClient.getModelConfig();
    let workspace = createModelWorkspace(latest);
    const preset = upsertByokPreset(workspace, {
      provider: PROVIDER_ID,
      endpoint: input.endpoint.apiBase,
      protocol: input.endpoint.protocol,
      apiKey: input.endpoint.apiKey,
      model: input.model,
      capabilities: input.capabilities
    });
    workspace = preset.workspace;
    for (const capability of input.assign) {
      workspace = assignCatalogPreset(workspace, "byok", capability, preset.presetId);
    }

    try {
      await input.configClient.saveModelCatalog(modelConfigInput(workspace));
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (attempt === 1 || (code !== "model_config_changed" && code !== "config_write_busy")) {
        throw error;
      }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix App/frontend/desktop exec vitest run src/state/tests/model-provisioning.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 写共用面板（含续接）**

`App/frontend/desktop/src/components/account-auth-panel.tsx`：把「表单 + 注册/登录 + 供给模型 + 选模式 + 自检 + 跳转」收敛到一处。

```tsx
/** Account auth panel module. */
import type { OnboardingStateDto } from "@memmy/local-api-contracts";
import { useState } from "react";
import type { CuberouterAuthResult } from "@memmy/local-api-contracts";
import { buildAccountOnboardingStartPatch, resolvePostLoginRoute, shouldShowFirstEncounterReport } from "../app/routes.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { setAnalyticsUserId } from "../analytics/analytics-context.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { openExternalUrl } from "../utils/open-url.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { provisionByokModel } from "../state/model-provisioning.js";
import { AuthCredentialsForm } from "./auth-credentials-form.js";
import { useAccountAuth } from "./use-account-auth.js";
import { useTranslation } from "../i18n/use-translation.js";

/** Cuberouter-backed register/login panel shared by the welcome and login pages. */
export function AccountAuthPanel() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t, language } = useTranslation();
  const auth = useAccountAuth();
  const [mode, setMode] = useState<"register" | "login">("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  async function submit() {
    if (auth.pending || continuing) return;
    setWarning(null);
    const result = mode === "register"
      ? await auth.register(username, password, confirmPassword)
      : await auth.login(username, password);
    if (!result) return;
    await continueAfterAuth(result);
  }

  async function continueAfterAuth(result: CuberouterAuthResult) {
    const session = result.session;
    if (!session.authenticated) return;

    setAnalyticsUserId(session.profile.userId);
    dispatch(appActions.accountUpdated({
      userId: session.profile.userId,
      email: session.profile.email ?? "",
      phoneNumber: session.profile.phoneNumber,
      nickname: session.profile.nickname,
      registeredAt: session.profile.registeredAt
    }));

    if (!clients?.config) {
      auth.setFailure({ text: t("account.error.provisionFailed"), tone: "error" });
      return;
    }

    try {
      setContinuing(true);
      await provisionByokModel({
        configClient: clients.config,
        endpoint: {
          apiBase: result.provisioning.apiBase,
          protocol: "openai-chat-completions",
          apiKey: result.provisioning.apiKey
        },
        model: result.provisioning.model,
        capabilities: ["agent", "memory_summary", "memory_evolution"],
        assign: ["agent", "memory_summary", "memory_evolution"]
      });
      const saved = await clients.config.getModelConfig();
      dispatch(appActions.modelConfigUpdated(saved));

      // 自检失败不阻断：新账号可能没有配额、或模型不在目标实例的能力表里。
      const test = await clients.config.testModelConfig(saved, "agent");
      if (!test.ok) {
        setWarning(t("account.warning.modelUnavailable", { reason: test.message }));
      }
    } catch (error) {
      console.error("provision model config failed", error);
      auth.setFailure({ text: t("account.error.provisionFailed"), tone: "error" });
      return;
    } finally {
      setContinuing(false);
    }

    const onboardingPatch: Partial<OnboardingStateDto> =
      session.profile.hasFinishedGuide && state.bootstrap && !shouldShowFirstEncounterReport(state.bootstrap.onboarding)
        ? { completed: true, currentStep: "completed", completedAt: new Date().toISOString(), hasAcceptedTerms: true }
        : buildAccountOnboardingStartPatch(state.bootstrap?.onboarding);
    const nextOnboarding = {
      ...buildAccountOnboardingStartPatch(state.bootstrap?.onboarding),
      ...state.bootstrap?.onboarding,
      ...onboardingPatch
    };

    try {
      setContinuing(true);
      await persistLoginModeSelection({
        configClient: clients.config,
        dispatch,
        userMode: "byok",
        onboarding: onboardingPatch
      });
      // 自检警告不影响路由：新用户走 onboarding，老用户按 guide 状态进主界面。
      dispatch(appActions.navigate(
        resolvePostLoginRoute({ onboarding: nextOnboarding, preferredMode: state.navigation.preferredMode })
      ));
    } catch (error) {
      console.error("persist byok mode failed", error);
      auth.setFailure({ text: t("login.error.modePersistenceFailed"), tone: "error" });
    } finally {
      setContinuing(false);
    }
  }

  return (
    <div className="space-y-3">
      <AuthCredentialsForm
        mode={mode}
        username={username}
        password={password}
        confirmPassword={mode === "register" ? confirmPassword : undefined}
        disabled={auth.pending || continuing}
        feedback={warning ? { text: warning, tone: "error" } : auth.feedback}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onConfirmPasswordChange={setConfirmPassword}
        onModeChange={(next) => { auth.clearFeedback(); setMode(next); }}
        onSubmit={() => void submit()}
        onOpenTerms={() => void openExternalUrl(getLegalLinkUrl("terms", language, state.bootstrap?.legal))}
        onOpenDataAgreement={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}
      />
    </div>
  );
}
```

注意：`AuthCredentialsForm` 里确认密码是「注册模式下由父组件传 `confirmPassword`、并回调 `onConfirmPasswordChange`」；`testModelConfig(saved, "agent")` 的第二个参数是 capability。

- [ ] **Step 6: 两个页面接上**

`welcome-page.tsx`：
- 删掉 `verificationCodeAuth`、identifier/code/inviteCode 状态、`submitLogin`、`continueAfterAccountEntry`、`resolveDesktopAccountChannel` 的使用
- `<AuthCodeForm .../>` 换成 `<AccountAuthPanel />`
- 顶部 import 清掉 `AuthCodeForm`、`useVerificationCodeAuth`、`buildInvitationSignupEvent`、`resolveInvitationToastKind`、`setAnalyticsUserId`（若不再使用）
- 保留「使用自定义大模型 API Key（无需注册）」按钮（`useOwnApiKey`）与语言切换

`login-page.tsx`：同样替换为 `<AccountAuthPanel />`，保留外层卡片与语言切换。

- [ ] **Step 7: 类型检查 + 测试**

Run: `npm --prefix App/frontend/desktop run typecheck`
Expected: PASS

Run: `npm --prefix App/frontend/desktop exec vitest run src/state/tests/model-provisioning.test.ts src/state/tests/model-workspace.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add -A App/frontend/desktop/src/state/model-provisioning.ts App/frontend/desktop/src/state/tests/model-provisioning.test.ts App/frontend/desktop/src/components/account-auth-panel.tsx App/frontend/desktop/src/pages/welcome-page.tsx App/frontend/desktop/src/pages/login-page.tsx
git commit -m "feat(auth): provision the cuberouter model config after register/login"
```

---

### Task 7: 云功能隐藏与旧代码清理

**Files:**
- Modify: `App/frontend/desktop/src/state/app-actions.ts`（`account/updated` 增加 `identityProvider`）
- Modify: `App/frontend/desktop/src/state/app-reducer.ts`（`AccountState` + 两个 case）
- Modify: `App/frontend/desktop/src/app.tsx`（bootstrap 时带上 `identityProvider`）
- Modify: `App/frontend/desktop/src/components/account-auth-panel.tsx`（登录成功后带 `identityProvider`）
- Modify: `App/frontend/desktop/src/pages/token-detail-page.tsx`（换成新面板 + 门控）
- Modify: `App/frontend/desktop/src/pages/tools-page.tsx`（门控 composio 加载）
- Modify: `App/frontend/desktop/src/pages/home-page.tsx`、`App/frontend/desktop/src/pages/pet-page.tsx`（门控 ASR 麦克风入口）
- Delete: `App/frontend/desktop/src/app/account-channel.ts`、`vite.config.ts` 里的 `MEMMY_ACCOUNT_CHANNEL` define、相关测试

**Interfaces:**
- Consumes: Task 1 的 `AccountProfileView.identityProvider`。
- Produces:
  - `AccountState.identityProvider: "memmy_cloud" | "cuberouter"`
  - `appActions.accountUpdated({ ..., identityProvider?: "memmy_cloud" | "cuberouter" })`
  - `canUseCloudFeatures(state: Pick<AppState, "account">): boolean`

**门控规则：** 凡是需要 memmy 云凭据的入口，在 `identityProvider === "cuberouter"` 时隐藏。注意：设置页的赠送额度通道、邀请横幅、improvement program **已经**因为 `userMode === "byok"` 而隐藏，本任务无需再动；实际要补的是 composio、ASR 与 `/token-detail` 的入口。

- [ ] **Step 1: 把 identityProvider 接进应用状态**

`app-actions.ts`：`AppAction` 的 `account/updated` 分支加 `identityProvider?: "memmy_cloud" | "cuberouter"`；`appActions.accountUpdated` 的入参类型同步加该字段。

`app-reducer.ts`：
- `AccountState` 加 `identityProvider: "memmy_cloud" | "cuberouter";`
- 初始 state 的 `account` 块加 `identityProvider: "memmy_cloud"`
- `account/updated` case 的 `account: {...}` 加 `identityProvider: action.identityProvider ?? state.account.identityProvider,`
- `account/cleared` case 的 `account: {...}` 加 `identityProvider: "memmy_cloud"`

`app.tsx`（约 233 行的 `dispatch(appActions.accountUpdated({...}))`）：加

```ts
            identityProvider: accountSession.profile.identityProvider
```

- [ ] **Step 2: 加门控辅助函数**

`App/frontend/desktop/src/state/app-reducer.ts` 导出：

```ts
/** True when the active identity still has a memmy cloud account behind it. */
export function canUseCloudFeatures(state: Pick<AppState, "account">): boolean {
  return state.account.identityProvider !== "cuberouter";
}
```

- [ ] **Step 3: 门控工具与语音入口**

`tools-page.tsx`（`useEffect` 里加载连接的地方，约 43 行）：

```tsx
  useEffect(() => {
    if (!clients || state.account.identityProvider === "cuberouter" || !shouldLoadConnectionsForPage(state.tools.status)) {
      return;
    }

    void toolsActions.loadConnections(clients.integrations, clients.channels, dispatch);
  }, [clients, dispatch, state.tools.status, state.account.identityProvider]);
```

并把工具页入口/内容用 `canUseCloudFeatures(state)` 包一层（不可用时显示一个说明面板，文案 `t("tools.cloudUnavailable")`；该 key 一并加进 messages.ts 的 zh/en）。

`home-page.tsx` 与 `pet-page.tsx`：把麦克风按钮的渲染条件加上 `canUseCloudFeatures(state)`（`startVoiceInput`/`finishVoiceInput` 与 `useAsrRecorder` 的调用点保持不动，只门控 UI 入口）。

- [ ] **Step 4: token-detail 页换成新面板并门控**

`token-detail-page.tsx`：把 `useVerificationCodeAuth` 及其表单替换为 `<AccountAuthPanel />`；欢迎页里指向它的赠送横幅（`welcome-page.tsx` 的 `showLoginBanner`）渲染条件加 `canUseCloudFeatures(state)`。

- [ ] **Step 5: 删掉账号渠道开关**

```bash
git rm App/frontend/desktop/src/app/account-channel.ts
```

`App/frontend/desktop/vite.config.ts`：删掉 `MEMMY_ACCOUNT_CHANNEL` 的 define（若其它地方引用 `import.meta.env.MEMMY_ACCOUNT_CHANNEL`，一并删）。同时删掉它的测试用例（`grep -rln "account-channel\|MEMMY_ACCOUNT_CHANNEL" App/frontend/desktop/src App/frontend/desktop/tests`）。

- [ ] **Step 6: 跑桌面全量测试**

Run: `npm --prefix App/frontend/desktop exec vitest run`
Expected: PASS。既有用例里凡是驱动验证码登录的（`settings-invitation-banner.test.tsx`、`byok-setup-save-feedback.interaction.test.tsx` 等）改成新的 `register`/`login` 桩；失败的逐一按新行为修正。

- [ ] **Step 7: 类型检查 + 后端测试**

Run: `npm --prefix App/frontend/desktop run typecheck && npm --prefix App/backend exec vitest run src/services src/adapters`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add -A App/frontend/desktop/src App/frontend/desktop/vite.config.ts
git commit -m "feat(auth): gate cloud-only entries behind the cuberouter identity"
```

---

### Task 8: 端到端冒烟

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-cuberouter-login-design.md`（把冒烟结论记进「测试」一节）
- 无源码改动（除非冒烟暴露问题）

**Interfaces:**
- Consumes: 前七个任务的全部产出
- Produces: 一份可复现的冒烟记录

- [ ] **Step 1: 起 cuberouter**

在本机 `cuberouter` 仓库：`docker compose up -d`（或直接跑仓库里的 `new-api` 二进制，端口 3000），确认 `curl -s http://127.0.0.1:3000/api/status` 有响应。

- [ ] **Step 2: 指向本机实例与可用模型**

本机实例的能力表只有 `qwen3.8-max-a` 与 `kimi-k3-a`（默认的 `deepseek-flash` 不在其中），所以冒烟时用：

```bash
export MEMMY_CUBEROUTER_URL=http://127.0.0.1:3000
export MEMMY_CUBEROUTER_MODEL=kimi-k3-a
```

- [ ] **Step 3: 走一遍注册**

启动桌面 `npm run dev:desktop`，在欢迎页用「注册」：用户名 `memmy-smoke-1`，密码 `Passw0rd1`。

Expected:
1. 无报错地进入下一步（新账号 → `/onboarding`）
2. `~/.memmy/config.yaml` 里出现：`providers.openai.endpoints` 有一条 `apiBase: http://127.0.0.1:3000/v1`、`apiKey: sk-...`；`modelPresets` 有一条 `model: kimi-k3-a`、`capabilities` 含 agent/memory_summary/memory_evolution；`modelAssignments.byok` 的 agent/memorySummary/memoryEvolution 都指向该 preset
3. `app.userMode: byok`

- [ ] **Step 4: 验证 key 真的能用**

```bash
KEY=$(grep -o 'sk-[A-Za-z0-9]*' ~/.memmy/config.yaml | head -1)
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"kimi-k3-a","messages":[{"role":"user","content":"ping"}]}' | head -c 300
```

Expected: 返回包含 `choices` 的 JSON，不是 `success:false`。

- [ ] **Step 5: 复发登录验证复用**

退出登录（设置页登出），再用同一账号走「登录」。

Expected:
1. 登录成功且 `~/.memmy/config.yaml` 的 apiKey 与上一步一致（复用同一个 token）
2. cuberouter 后台该用户的 token 数量没有增加：`sqlite3 one-api.db "select count(*) from tokens where user_id=<id>;"`
3. 若这一步自检失败，界面给出「模型暂时不可用」警告但**仍然进入主界面**（D7）

- [ ] **Step 6: 记录结论**

把实际观察到的结果（含偏差）追加到 spec 的「11. 测试」一节，并提交：

```bash
git add docs/superpowers/specs/2026-09-16-cuberouter-login-design.md
git commit -m "docs(auth): record cuberouter smoke results"
```

---

## 计划外但已知的残留（不在本计划范围）

- `verification_code_throttle` 表与 `AccountSessionRepository.getLastCodeSentAt`/`markCodeSent` 在验证码登录移除后成为死代码，本次保留（涉及表结构，单独清理）。
- `login.*` 系列 i18n key 里验证码相关的若干条会变成未使用文案，本次保留。
- `cloudClient` 及其适配器保留（composio/ASR 等入口只是被门控，未删除）。
- 打包版把 `MEMMY_CUBEROUTER_URL` 注入 edition manifest 的强校验清单，属于后续项。
