# cuberouter 注册登录与模型自动配置 — 设计

- 日期：2026-09-16
- 状态：待评审
- 涉及仓库：`memmy-agent`（本仓库）、`cuberouter`（外部依赖，REST API 提供方）

## 1. 背景

Memmy 桌面端当前的账号入口是**验证码登录**：`/welcome` 与 `/login` 都渲染同一套 `AuthCodeForm`（邮箱或手机号 + 验证码），新用户注册是隐式的——登录接口返回 `isNewUser` 即视为注册。凭据是 memmy 云服务（`MEMMY_CLOUD_SERVICE`，默认 `https://memmy-api.memtensor.cn`）的 `/api/agentUser/*`，云返回的 uuid 既当身份标识又当 bearer 凭据。

模型配置与账号是两套独立存储：账号在本地 SQLite（`cloud_accounts` + 加密 `secret_store`），模型在 `~/.memmy/config.yaml`（`providers` / `modelPresets` / `modelAssignments`）。账号登录只投影一份平台托管的模型配置（`writeAccountModelProjection`），不含真实 LLM 密钥。

现在要改成：**客户端用户注册 → 请求 cuberouter 注册 → 登录拿 JWT → 创建 API key → 取回 API key → 为 memmy 配置模型（固定模型）**，即 cuberouter 同时成为账号来源和模型来源。

## 2. 目标与非目标

### 目标

1. 桌面端用**用户名 + 密码**注册 cuberouter 账号，注册成功后自动完成登录、取回 API key、并把该 key + 固定模型写入 `~/.memmy/config.yaml`，用户无需手工配置即可开始对话。
2. 已注册用户可再次登录，**复用**上次创建的 API key，不重复堆积 token。
3. 账号身份从 memmy 云换成 cuberouter 用户，本地账号会话（昵称、注册时间等）照常可用。
4. 整条链路对用户可解释：每一步失败都有明确的中文提示和可重试路径。

### 非目标

1. **不给 composio / ASR 换后端**。这些能力原先依赖 memmy 云凭据，本次只做"隐藏"，不做替代实现。
2. **不做额度/用量对接**。cuberouter 的配额不在本次接入，用量面板按 BYOK 的本地统计展示。
3. **不做多账号切换**。同一时刻只有一个 cuberouter 身份。
4. **不做 2FA**。目标账号若开启了 2FA，本次直接报错提示。
5. **不把 embedding 指到 cuberouter**。embedding 保持 memmy 默认的本地模式。
6. **不把 `MEMMY_CUBEROUTER_*` 写进 edition manifest 的强校验清单**（见 §9）。

## 3. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **直接替换**验证码登录，不做并列模式 | 用户明确选择。保留两套登录会长期维护两条身份链路。 |
| D2 | 身份换、**云功能按需隐藏** | 登录后不再有云 uuid，依赖它的功能（composio、ASR、邀请码、赠送额度、云端 guide）无凭据可用，只能隐藏。 |
| D3 | 重复登录**复用**名为 `memmy-desktop` 的 token | cuberouter 每个用户有 token 数量上限（`GetMaxUserTokens`），每次登录新建会撞上限并堆积垃圾数据。 |
| D4 | 地址与模型名走**环境变量**：`MEMMY_CUBEROUTER_URL`（默认 `http://127.0.0.1:3000`）、`MEMMY_CUBEROUTER_MODEL`（默认 `deepseek-flash`） | 本机开发可用默认值；打包后可指向远端网关、可换模型，不必改代码。 |
| D5 | 方案 A：**后端管账号、桌面走既有 BYOK 通路写模型** | 写配置复用唯一被支持的通路（`writeModelConfigCatalog` + `projectMemoryConfig` + 乐观锁），避免在后端再造一份目录写入逻辑。密钥本来就在渲染进程流转（用户手输 BYOK 同理），无新增暴露面。 |
| D6 | 写配置时 provider id **复用 `openai`** + 自定义 apiBase | catalog 的 provider 白名单（`CatalogProviderId`）是共享契约，新增 id 要同时改契约、后端校验、前端 `normalizeProvider`/`providerOptions`、runtime `ProviderSpec` 和 i18n。cuberouter 是 OpenAI 兼容的，复用 `openai` 零契约改动、风险最低。 |
| D7 | 模型**连接自检失败不阻断**登录 | 新注册的 cuberouter 账号默认配额为 0、模型可能不在能力表里；若阻断，用户会被锁在注册页外，且账号其实已经建好了。自检失败只给警告。 |
| D8 | 登出**只清本地会话**，`config.yaml` 里的模型配置保留 | 与现有 BYOK 语义一致（登出不删除用户自己配置的 key）。已知残留：再次登录其它账号时，新 key 会成为新的 endpoint/preset，旧 preset 留在目录里不删。 |
| D9 | 不调用 cuberouter 的登出接口 | 其 `/api/user/auth/logout` 走 `SessionCookieOriginGuard`，需要 refresh cookie；我们只持有 access token。本地清掉 JWT 即可，服务端会话自行过期。 |
| D10 | `userMode` 置为 `"byok"` | cuberouter 的 key 是真实可用的 LLM 凭据，语义上是 BYOK 而非平台托管；runtime 的 `byok` 分支也要求存在可用的 BYOK agent 选择。 |

## 4. 架构与组件

### 4.1 新增：cuberouter 出站适配器

目录 `App/backend/src/adapters/outbound/cuberouter-client/`。

```ts
export function createHttpCuberouterClient(options: {
  baseUrl: string;      // 例如 http://127.0.0.1:3000，已去掉尾部斜杠
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): CuberouterClient;

export interface CuberouterClient {
  register(input: { username: string; password: string }): Promise<void>;
  login(input: { username: string; password: string }): Promise<CuberouterSession>;
  listTokens(): Promise<CuberouterTokenSummary[]>;      // { id, name }
  createToken(input: { name: string }): Promise<void>;
  getTokenKey(tokenId: number): Promise<string>;        // 返回 sk-...
  getSelf(): Promise<CuberouterSelf>;                   // { userId, username, displayName, quota, group }
}

export interface CuberouterSession { accessToken: string; expiresAt?: string; userId: string; username: string; displayName?: string; }
```

对应 cuberouter REST（已核对 `controller/user.go`、`controller/token.go`、`router/api-router.go`）：

| 方法 | cuberouter 端点 | 说明 |
|---|---|---|
| `register` | `POST /api/user/register` | body `{username, password}`。返回 `{success, message}`，**无 data**。 |
| `login` | `POST /api/user/login` | body `{username, password}`。`data.access_token` 即 JWT，另含 `session`、`user`。 |
| `listTokens` | `GET /api/token/` | 返回 `{page, page_size, total, items}`，item 的 `key` 已打码但带 `id`、`name`。 |
| `createToken` | `POST /api/token/` | body 为 `model.Token` 字段 + `auto_groups`。**不返回 id、不返回 key**。 |
| `getTokenKey` | `POST /api/token/{id}/key` | 返回 `data.key` 明文。 |
| `getSelf` | `GET /api/user/self` | 返回用户资料与 `quota`。 |

所有请求带 `Authorization: Bearer <accessToken>`（`middleware.UserAuth` 通过 `ParseDashboardAccessToken` 接受该 token）；注册与登录不带。

错误映射。cuberouter 的业务错误是 **HTTP 200 + `success: false` + 已经按 `lang` 本地化好的 message**（`common.ApiErrorI18n`），只有鉴权中间件才返回 401。因此**不做 message 文本匹配**——服务端有中英两套文案，靠关键词匹配必然脆——只保留三个有行为差异的码，其余一律透出服务端原文：

- `two_factor_required`：**结构化判定**（login 返回 `success: true` 且 `data.require_2fa === true`）
- `service_unavailable`：传输失败或超时
- `rejected`：其余一切失败；`message` 直接用服务端原文（用户名已存在、注册被禁用、密码强度、Turnstile、邮箱验证、令牌数量上限等都走这一条，在 UI 上原样展示）

### 4.2 新增：编排服务

`App/backend/src/services/cuberouter-account-service.ts`

```ts
export interface CuberouterAccountService {
  register(input: { username: string; password: string }): Promise<CuberouterAuthResult>;
  login(input: { username: string; password: string }): Promise<CuberouterAuthResult>;
  logout(): Promise<OkResponse>;
}
```

- `register`：`client.register` → `completeLogin(username, password)`
- 会话写入**不传 `isNewUser`**，交给 `AccountSessionRepository.upsert` 按"是否已有该 `user_id` 的行"自行判定；写死 `true` 会让老用户每次登录都被当成新用户、重走一遍 onboarding。
- `login`（含注册后的续接，内部 `completeLogin(username, password)`）：
  1. `client.login` → JWT + 用户资料
  2. `ensureApiKey(jwt)` → 明文 key
  3. 写本地账号会话（§6）
  4. 返回 `{ session, provisioning: { apiKey, apiBase, model } }`，其中 `apiBase = \`${config.baseUrl}/v1\``、`model = config.model`
- `logout`：清本地会话（不调 cuberouter，见 D9）

`ensureApiKey(accessToken)` 是 D3 的落点，也是整个流程里唯一有分支的地方：

```text
tokens = listTokens()
target = tokens.find(t => t.name === "memmy-desktop")
if (target) return getTokenKey(target.id)
createToken({ name: "memmy-desktop", unlimitedQuota: true, expiredTime: -1 })
tokens = listTokens()                      // 必须重列：创建接口不返回 id
created = tokens.find(t => t.name === "memmy-desktop")
if (!created) throw provision_failed
return getTokenKey(created.id)
```

新建 token 的 body 取 `{ name, expired_time: -1, unlimited_quota: true, remain_quota: 0, model_limits_enabled: false, group: "" }`（跟随用户默认分组，不强制 `auto`，避免触发 `auto_groups` 校验）。

### 4.3 新增：配置解析

`App/backend/src/config/service-urls.ts` 增加：

```ts
export interface CuberouterClientConfig { baseUrl: string; model: string; timeoutMs: number; }

export function resolveCuberouterClientConfig(env: NodeJS.ProcessEnv): CuberouterClientConfig {
  return {
    baseUrl: (env.MEMMY_CUBEROUTER_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, ""),
    model: env.MEMMY_CUBEROUTER_MODEL?.trim() || "deepseek-flash",
    timeoutMs: Number.parseInt(env.MEMMY_CUBEROUTER_TIMEOUT_MS ?? "10000", 10)
  };
}
```

### 4.4 契约变更

`App/backend/local-api-contracts/src/index.ts`：

```ts
/** 注册/登录入参。用户名与密码规则对齐 cuberouter 的 User 校验。 */
export const CuberouterAuthInputSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(8).max(20)
});
export type CuberouterAuthInput = z.infer<typeof CuberouterAuthInputSchema>;

/** 注册/登录结果：会话 + 模型供给信息（不含 provider/protocol，由桌面决定）。 */
export const CuberouterAuthResultSchema = z.object({
  session: AccountSessionViewSchema,
  provisioning: z.object({
    apiKey: z.string().min(1),
    apiBase: z.string().url(),
    model: z.string().min(1)
  })
});
export type CuberouterAuthResult = z.infer<typeof CuberouterAuthResultSchema>;
```

`AccountSessionProfileViewSchema` 增加 `identityProvider: z.enum(["memmy_cloud", "cuberouter"])`（已有账号行按 `_memmyAuthChannel` 推断缺省值 `"memmy_cloud"`）。

### 4.5 本地 HTTP 路由

`App/backend/src/adapters/inbound/local-api/routes/account.ts`：

- **新增** `POST /api/account/register`、`POST /api/account/login`（body 走 `CuberouterAuthInputSchema`，响应 `CuberouterAuthResultSchema`，沿用 `authenticateRuntimeToken` + `withErrorEnvelope`）
- **删除** `POST /api/account/send-code`、`POST /api/account/verify-code`
- `GET /api/account/session`、`POST /api/account/logout`、`PATCH /api/account/profile`、`POST /api/account/guide-finished` 保留
- `PUT /api/account/invitation`：cuberouter 身份下固定返回 `{ enabled: false, invitationCode: "", usedSlotsToday: 0, dailyLimitReached: false }`，不再请求云端

### 4.6 桌面改动

- `App/frontend/desktop/src/api/account-client.ts`：`sendCode`/`verifyCode` → `register`/`login`（返回 `CuberouterAuthResult`）
- `App/frontend/desktop/src/components/auth-code-form.tsx` → 替换为 `auth-credentials-form.tsx`：用户名 + 密码（注册时多一个确认密码）。密码本地预校验 8–20 位且同时含大写、小写、数字，与 cuberouter 的 `passwordStrength` 一致，避免白跑一趟拿服务端错误
- `App/frontend/desktop/src/components/use-verification-code-auth.ts` → 替换为 `use-account-auth.ts`（暴露 `register`/`login`/`pending`/`error`）
- `App/frontend/desktop/src/pages/welcome-page.tsx` 与 `login-page.tsx`：两页目前近乎重复（同样的表单 + 只差命名的提交函数），本次合并为一个共用 `AccountAuthPanel` 组件，由「注册」「登录」两个按钮决定调用哪个入口；成功后的续接逻辑（写模型配置 → 选模式 → 自检 → 跳转）收敛到一处
- **新增** `App/frontend/desktop/src/state/model-provisioning.ts`：

  ```ts
  export async function provisionByokModel(input: {
    configClient: ConfigClient;
    endpoint: { apiBase: string; protocol: ModelEndpointProtocol; apiKey: string };
    model: string;
    /** 写进 preset.capabilities 的能力。 */
    capabilities: ModelCapability[];
    /** 需要指向该 preset 的 assignment 槽位（agent / memory_summary / memory_evolution / embedding）。 */
    assign: ModelCapability[];
  }): Promise<void>;
  ```

  内核即 `api-key-page.tsx` 里 `saveConfig` 的现有步骤：`getModelConfig()` → `upsertByokPreset({ provider: "openai", endpoint: input.endpoint.apiBase, protocol: input.endpoint.protocol, apiKey, model, capabilities })` → 对 `assign` 里每个能力调 `assignCatalogPreset(workspace, "byok", capability, presetId)` → `modelConfigInput` → `saveModelCatalog`。

  **调用方各自决定能力集，既有页面的行为不变**：
  - 注册/登录续接：`protocol: "openai-chat-completions"`，`capabilities: ["agent","memory_summary","memory_evolution"]`，`assign` 同这三项
  - `api-key-page.tsx` 的 `saveConfig`：`capabilities: ["agent"]`、`assign: ["agent"]`，embedding 仍走它自己那段（协议是 `openai-embeddings`，且带「本地/自定义」模式判断）
- 登录/注册成功后续接：`provisionByokModel(...)` → `persistLoginModeSelection({ userMode: "byok" })` → `POST /api/app/model-config/test`（现有接口，`app-config.ts:110`）→ `resolvePostLoginRoute`（新用户 `/onboarding`，老用户按 guide 状态进 `/main`）
- 云功能 gate（§7）：`settings-page.tsx`、`tools-page.tsx` 等按 `session.profile.identityProvider === "cuberouter"` 隐藏对应入口
- 删除因替换而失效的 `MEMMY_ACCOUNT_CHANNEL` / `resolveDesktopAccountChannel()` / `assertExpectedAccountChannel()` 及其 vite define 与测试

## 5. 数据流

### 5.1 注册（新用户）

```text
桌面(用户名+密码) → POST /api/account/register
  → cuberouter POST /api/user/register          (失败：username_taken / registration_disabled / invalid_argument)
  → cuberouter POST /api/user/login             (拿 JWT + user)
  → GET /api/token/ → 无 "memmy-desktop"
  → POST /api/token/ → GET /api/token/ 取 id → POST /api/token/{id}/key → sk-...
  → 写本地账号会话（SQLite cloud_accounts + 加密 secret_store 存 JWT）
  → 返回 { session, provisioning: { apiKey, apiBase, model } }
桌面 → getModelConfig → upsertByokPreset + 指 assignments → PUT /api/app/model-config
  → writeModelConfigCatalog + projectMemoryConfig → memoryClient.reloadConfig({reason:"model_config_saved"})
桌面 → persistLoginModeSelection({userMode:"byok"}) → POST /api/app/model-config/test（不阻断）
  → /onboarding
```

### 5.2 登录（已注册用户）

同上，去掉 register，且 `ensureApiKey` 命中同名 token 走 `getTokenKey` 复用分支；路由按 `hasFinishedGuide` 决定进 `/onboarding` 还是 `/main`。

### 5.3 登出

`POST /api/account/logout` → 清 `cloud_accounts` 活跃标记与 `secret_store` 中的 JWT → 桌面回到 `/welcome`。`config.yaml` 不动（D8）。

## 6. 会话与身份存储

复用 `AccountSessionRepository`，只换语义，不改表结构：

| 现有字段/方法 | cuberouter 语义 |
|---|---|
| `cloud_accounts.uuid`（主键） | `cuberouter:<userId>`，加前缀避免与 memmy 云 uuid 撞键 |
| `cloud_uuid_ref` → `secret_store` | 存 JWT（原为云 uuid 作 bearer） |
| `getCloudUuid()` | 语义变为"取当前身份的 bearer 凭据"。**函数名不改**，避免大范围重命名；语义在代码注释与本文件记录 |
| `raw_profile_json._memmyAuthChannel` | 值 `"cuberouter"`；`AccountSessionView.profile.identityProvider` 由此派生 |
| `user_id` / `nickname` | cuberouter 的 `userId` / `displayName ?? username`（`get()` 判定 `authenticated` 需要这两个字段非空） |
| `registeredAt` | cuberouter `user.created_time`（若缺失则用登录时刻） |

`planType` 与 `region` 保持为空。

写入侧传 `authChannel: "cuberouter"`，但**读取侧要两处配合才读得出来**：`resolveExplicitAccountAuthChannel` 现在硬编码 `value === "email" || value === "phone"`，必须改成按 `AccountChannelSchema` 解析；`toProfileView` 与 `upsert` 的返回对象都要带上 `identityProvider`（否则 schema 的 `.default("memmy_cloud")` 会把 cuberouter 会话写成云身份）。

**JWT 的生命周期**：只在注册/登录那一次调用链里使用，过期不影响日常运行（key 已在 `config.yaml`）。将来若要"重新获取 key"，需要重新输入密码登录。

## 7. 云功能隐藏

规则：**凡以云 uuid 作凭据的 UI 入口，在 `identityProvider === "cuberouter"` 时隐藏**。已知落点：

| 入口 | 位置 | 处理 |
|---|---|---|
| 平台赠送额度通道 | `settings-page.tsx`（`showPlatform` / `showGiftQuota`） | 隐藏 |
| 邀请码 | 邀请横幅与 `avatar menu` | 接口已固定返回 `enabled:false`，入口随之隐藏 |
| composio 工具集成 | `tools-page.tsx` | 隐藏入口 |
| ASR 语音转写 | 录音入口 | 隐藏 |
| improvement program | `improvement-program-modal` | 隐藏 |
| 云端 guide 状态 | `markGuideFinished` | 本地记录，不再回写云端 |

用量面板**不需要 gate**：BYOK 用量本就有本地统计（`byok-token-usage-service`），cuberouter 走 BYOK 通路后自动按 BYOK 展示。

`cloudClient` 及其适配器代码保留（本次不删），只是不再被登录流程驱动。

## 8. 错误处理

分两层：**表单层**负责把服务端原文放到用户眼前，**流程层**负责区分"能重试"和"要换做法"。

表单常驻一个「已有账号？去登录 / 没有账号？去注册」切换按钮，所以**不依赖任何错误码来做分支**——用户看到"用户名已存在"后自己切换即可。这是有意为之：见 §4.1 关于不做文本匹配的理由。

| 场景 | 错误码 | 用户可见提示 | 是否阻断 |
|---|---|---|---|
| 密码不满足 8–20 位或缺少大小写/数字 | 本地预校验，不发请求 | 密码需 8–20 位且包含大写、小写和数字 | 阻断 |
| 两次密码不一致 | 本地预校验 | 两次输入的密码不一致 | 阻断 |
| 用户名已存在 / 注册被禁用 / 密码强度被拒 / Turnstile / 邮箱验证 / 令牌数量上限 | `rejected` | **服务端原文**（cuberouter 按请求 `lang` 本地化） | 阻断 |
| 用户名或密码错误 | `rejected` | 服务端原文 | 阻断 |
| 账号开启 2FA | `two_factor_required` | 该账号启用了两步验证，本版本不支持，请在服务端关闭后重试 | 阻断 |
| cuberouter 不可达/超时 | `service_unavailable` | 无法连接服务，请检查服务地址与网络 | 阻断 |
| 建完列表里找不到 token / 取 key 失败 | `rejected` | cuberouter 未返回新建的令牌 | 阻断，可重试（幂等） |
| 写配置冲突 | `config_write_busy` / `model_config_changed` | 自动重试一次；仍失败提示"模型配置写入失败，请重试" | 阻断但账号已建 |
| 连接自检失败（模型不存在、额度为 0、分组无权限） | — | 警告："模型暂时不可用：<原因>" | **不阻断**（D7） |

## 9. 配置项

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MEMMY_CUBEROUTER_URL` | `http://127.0.0.1:3000` | cuberouter 服务地址（不含 `/v1`） |
| `MEMMY_CUBEROUTER_MODEL` | `deepseek-flash` | 固定模型名 |
| `MEMMY_CUBEROUTER_TIMEOUT_MS` | `10000` | 超时 |

写入 `.env.example`。**不进** `scripts/internal/shared/write-desktop-edition-manifest-lib.mjs` 的 edition manifest（该处校验要求 HTTPS origin 且不含路径，会把本地默认值挡掉）；打包版由进程环境注入，与 `MEMMY_CLOUD_URL` 同级。后续要进清单时再扩展该 lib 及其测试。

## 10. 幂等

- `ensureApiKey` 以 token 名为幂等键：重跑注册/登录不会新建 token，只会复用并重新取 key。
- 模型配置写入走 `PUT /api/app/model-config` 的既有乐观锁；同一 `apiBase` + 同一 `apiKey` 重复写入会被 `upsertByokPreset` 识别为同一 endpoint 并就地更新。
- 因此"注册成功但模型配置失败"的用户，重新登录一次即可补齐。

## 11. 测试

**后端**
- `cuberouter-client` 单测（fetch stub）：register/login 的成功与各错误码映射；`ensureApiKey` 的复用分支、创建分支（含"创建后必须重列取 id"）、`provision_failed`
- `cuberouter-account-service` 单测：注册串登录、会话写入（uuid 前缀、JWT 落 secret_store）、登出清理、`identityProvider` 派生
- contracts：新增 schema 的解析测试；旧账号行读出的 `identityProvider` 缺省为 `memmy_cloud`

**桌面**
- 新表单交互测试（照 `App/frontend/desktop/src/pages/tests/byok-setup-save-feedback.interaction.test.tsx`）：密码本地校验、注册成功→跳转、`username_taken`→预填并切到登录
- `provisionByokModel` 单测（照 `App/frontend/desktop/src/state/tests/model-workspace.test.ts`）：给定 `apiBase`/`apiKey`/`model`，断言产出的 `ModelConfigInput` 里 provider 为 `openai`、endpoint 为 `<apiBase>`、preset capabilities 为三项、`modelAssignments.byok` 的 agent/memorySummary/memoryEvolution 均指向该 preset
- 受影响的既有测试同步更新：`account-client` 测试、`settings-invitation-banner.test.tsx`、`byok-setup-save-feedback.interaction.test.tsx`

**手动冒烟**
1. 本地起 cuberouter（`docker compose up` 或 `new-api` 二进制，端口 3000）
2. `MEMMY_CUBEROUTER_MODEL=kimi-k3-a`（**本机实例能力表只有 `qwen3.8-max-a` 与 `kimi-k3-a`，没有 `deepseek-flash`**）
3. 走一遍注册 → 检查 `~/.memmy/config.yaml` 的 provider/endpoint/preset/assignments → 发一条消息验证模型可用
4. 重新走一遍登录，确认复用同一个 token（cuberouter 后台 token 数量不增加）

## 12. 实施顺序

各阶段都能独立验证，前四步不碰 UI，可先合入：

1. **契约与配置**：contracts 新增 schema、`resolveCuberouterClientConfig`、`.env.example` 补三个变量
2. **cuberouter 客户端**：适配器 + 单测（纯 fetch stub，不需要真服务）
3. **编排服务**：`ensureApiKey` + 会话写入 + 单测
4. **本地路由切换**：`+POST /register`、`+POST /login`、`-send-code`、`-verify-code`，`account-service` 瘦身
5. **桌面**：`account-client` 改接新接口 → 密码表单 → 两页合并 → `provisionByokModel` + 续接
6. **收尾**：云功能 gate、删除 `MEMMY_ACCOUNT_CHANNEL` 与验证码相关代码、更新既有测试
7. **手动冒烟**：本地 cuberouter 跑通注册 → 检查 `config.yaml` → 实际对话

## 13. 改动文件清单

**后端新增**
- `App/backend/src/adapters/outbound/cuberouter-client/{types.ts,http-cuberouter-client.ts,index.ts}`
- `App/backend/src/adapters/outbound/cuberouter-client/tests/http-cuberouter-client.test.ts`
- `App/backend/src/services/cuberouter-account-service.ts`
- `App/backend/src/services/tests/cuberouter-account-service.test.ts`

**后端修改**
- `App/backend/src/config/service-urls.ts`（+ `resolveCuberouterClientConfig`）
- `App/backend/src/index.ts`、`App/backend/src/services/index.ts`（装配）
- `App/backend/src/adapters/inbound/local-api/routes/account.ts`
- `App/backend/src/services/account-service.ts`（-`sendCode`/`-verifyCode`；invitation 返回静态禁用）
- `App/backend/local-api-contracts/src/index.ts`

**桌面修改**
- `App/frontend/desktop/src/api/account-client.ts`
- `App/frontend/desktop/src/components/{auth-credentials-form.tsx,use-account-auth.ts}`（替代 `auth-code-form.tsx`、`use-verification-code-auth.ts`）
- `App/frontend/desktop/src/pages/{welcome-page.tsx,login-page.tsx}`（合并为共用面板）
- `App/frontend/desktop/src/state/model-provisioning.ts`（+ 测试）
- `App/frontend/desktop/src/pages/api-key-page.tsx`（`saveConfig` 改调 `provisionByokModel`）
- `App/frontend/desktop/src/pages/{settings-page.tsx,tools-page.tsx}` 等云功能 gate
- `App/frontend/desktop/src/i18n/messages.ts` 及相关语言资源
- `App/frontend/desktop/vite.config.ts`、`App/frontend/desktop/src/app/account-channel.ts`（删除 `MEMMY_ACCOUNT_CHANNEL`）

**配置**
- `.env.example`

## 14. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 目标实例开启 Turnstile / 邮箱验证 / 2FA | 注册登录直接失败 | 服务端默认均为关闭；错误码单独提示"请在服务端关闭后重试"（§8） |
| 新用户配额为 0（`QuotaForNewUser` 默认 0） | key 拿到但调用被拒 | 连接自检不阻断并给出警告；配额属服务端运维配置，本设计不接管 |
| 默认模型 `deepseek-flash` 不在目标实例能力表 | 首次对话失败 | env 可覆盖；自检警告中透出服务端原因 |
| 密码规则（8–20、含大小写数字）用户不知情 | 反复失败 | 前端按同一规则预校验并给出明确提示 |
| 云功能隐藏遗漏 | 出现点了报错的入口 | 实施时按 §7 清单逐个走查；`cloudClient` 保留便于回退 |
| 复用 token 名前缀与他人约定冲突 | 误用他人 token | token 名 `memmy-desktop` 是产品级约定；列表按名精确匹配 |
