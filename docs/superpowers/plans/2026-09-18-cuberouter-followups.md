# cuberouter 联调记录与后续项

- 日期：2026-09-18
- 分支：`feat/cuberouter-login`
- 状态：联调中（本地 `127.0.0.1:3000` → `test.cuberouter.cn`）
- 上游文档：
  - 设计：`docs/superpowers/specs/2026-09-16-cuberouter-login-design.md`
  - 计划：`docs/superpowers/plans/2026-09-16-cuberouter-login.md`

这个文档两个用途：**第 1 节记后续项（F 编号，当 issue 用）**，**第 2 节边测边记**。

---

## 1. 后续项

### F1 让 `config.yaml` 支持配置 cuberouter 地址与模型 ★

**为什么**

现在服务端地址只能从环境变量来——`resolveCuberouterClientConfig(process.env)` 是唯一入口（`App/backend/src/index.ts:125` → `App/backend/src/config/service-urls.ts:29`），`config.yaml` 里没有任何同类键。后果：

- 换一次环境（localhost ↔ test.cuberouter.cn）就要改一次环境变量；Windows 上 `setx` 还得注销重登才被开始菜单启动的进程读到。
- 打包版没法"带着一个默认服务端"发布，只能靠用户自己配环境变量。
- 原计划的残留项 F2（把 `MEMMY_CUBEROUTER_*` 注入 edition manifest）被卡住，因为 manifest 校验要求 HTTPS origin，会挡掉本地默认的 `http://127.0.0.1:3000`。走 `config.yaml` 绕开这个矛盾。

**目标**

```yaml
cuberouter:
  baseUrl: https://test.cuberouter.cn   # 结尾斜杠会被去掉
  model: kimi-k3-a
  timeoutMs: 20000                     # 可选
```

读取优先级：**env > config.yaml > 现有默认值**（`http://127.0.0.1:3000` / `deepseek-flash` / `10000`）。三者都缺时行为与现在完全一致。

**涉及文件**

- `App/backend/src/config/service-urls.ts` —— `resolveCuberouterClientConfig` 多接一个配置源参数
- `App/backend/src/index.ts:125` —— 读配置并传进去
- `App/backend/src/infrastructure/memmy-config/` —— 从这里读 `cuberouter` 段
- `.env.example` —— 补一句"也可在 config.yaml 配"
- Test: `App/backend/src/config/tests/service-urls.test.ts`

**实现要点（已核实，别踩）**

1. **不要走 `loadMemmyConfig` / `Config` 类那条路。** `Config` 的构造函数是 `super()` 之后逐字段赋值（`App/memmy-agent/src/config/schema.ts:1163` 起，`super()` 在 1179 行），既没有 `toObject` override 也没有未知键兜底——**根级未知键会在 load 时被静默丢掉**。
2. **走 backend 的 raw-YAML 通路。** `App/backend/src/infrastructure/memmy-config/` 本来就是直接操作解析后的 YAML（`writeModelConfigCatalog` → `mutateRuntimeConfig`，`model-config-catalog.ts:69`），从那里读 `cuberouter` 段最省事，也不受 schema 类影响。
3. **写回安全，已验证。** 模型配置写回是 `return { ...config, providers, modelPresets, modelAssignments }`（`model-config-catalog.ts:165`），先展开原配置再覆盖这三个键，所以用户手写的 `cuberouter:` 段**不会被模型配置的写回抹掉**。

**验收**

- [ ] 只设 env：行为不变（现有测试全绿）
- [ ] 只写 config.yaml：生效
- [ ] 两者都设：env 赢
- [ ] 都不设：仍是 `http://127.0.0.1:3000` + `deepseek-flash`
- [ ] 保存模型配置后，`cuberouter:` 段仍在 config.yaml 里

**注意**：这个键只影响"登录/注册/发 key 打哪个服务端"；登录之后写进 config.yaml 的模型 endpoint（`providers.openai.endpoints.*.apiBase`）是另一回事，仍由 `baseUrl + /v1` 推导（`cuberouter-account-service.ts:59`）。

---

### F2 打包版注入 `MEMMY_CUBEROUTER_*`（被 F1 挡着）

原计划末尾记的残留项：`scripts/internal/shared/write-desktop-edition-manifest-lib.mjs` 的校验要求 HTTPS origin，会把本地默认值挡掉。F1 做完后可以用 `config.yaml` 承载默认值，这条要么改成"只注入生产 origin"，要么直接作废。

### F6 构建不该依赖 shell 里 export 过的 legal 变量

**现象**：Windows 上重新打包，4m25s 时死在 `Build Electron desktop shell`：

```
Error: MEMMY_LEGAL_CN_BASE_URL must be an HTTPS origin without a path.
    at validateLegalEnv (vite.config.ts:29)
```

**根因**：`MEMMY_LEGAL_CN_BASE_URL` / `MEMMY_LEGAL_INTL_BASE_URL` 没有任何打包脚本提供，唯一来源是仓库根的 `.env`（vite 的 `envDir` 指向仓库根），而 `.env` 是 **gitignore 的**（`.gitignore:22`）——永远不随 pull 过来。上次成功是因为那个终端窗口里 export 过，窗口一关就没了。

**绕过**：在仓库根建 `.env`。补第一个 legal 变量后又撞出 `MEMMY_CLOUD_SERVICE`（`write-desktop-edition-manifest-lib.mjs:33-40`，它也是先看 process.env 再回落到根 `.env`），所以**一共三行**：

```
MEMMY_LEGAL_CN_BASE_URL=https://memmy.cn
MEMMY_LEGAL_INTL_BASE_URL=https://memmy.bot
MEMMY_CLOUD_SERVICE=https://memmy-api.memtensor.cn
```

**这三个是整条打包链里唯一做强制校验的外部变量**（扫过 `scripts/` 下所有 `throw new Error("MEMMY_...")` 和变量引用）。其余几十个 `MEMMY_*` 都是脚本内部自己设的。`.env.example` 里剩下的 `MEMMY_CUBEROUTER_*` 是运行期的，构建不需要。

**为什么是安全的**：`.env` 只在构建期给 vite 读；`electron-builder.yml:17-18` 明确排除 `**/.env`，产物里没有它；运行时读的是系统环境变量。

**已做**：新增 `scripts/package-win-local.sh` —— 本地一键打包，把这几件事按顺序做掉：补 `.env`（缺哪个补哪个，值从 `.env.example` 取）、默认开镜像、**关掉在跑的 Memmy**、清掉 `release/win-unpacked`，然后原样交给 `package-win.sh`。版本默认读 `package.json`，edition 默认 `intl`。

```bash
bash scripts/package-win-local.sh                    # 一条命令
bash scripts/package-win-local.sh --prepare-only     # 只做本地准备，不打包（用来验证环境）
MEMMY_PACKAGE_MIRROR=off bash scripts/package-win-local.sh   # 走 GitHub 直连
```

**还值得做的**（不是现在）：`package-win.sh` 自己在开跑前也检查这三个变量，缺了就立刻报错并指向 `.env.example`，而不是等 4 分半死在 vite 构建里。校验本身要保留（它防的是打出法律条款指向错站点的包）。

### F3 验证码登录移除后的死代码清理

`verification_code_throttle` 表、`AccountSessionRepository.getLastCodeSentAt` / `markCodeSent`、以及 `login.*` 里一批验证码相关 i18n key 在验证码登录移除后已无调用方。涉及表结构，单独清理，不和本次联调混在一起。

### F4 登录页上两处 memmy 云时代的遗留（定制版要隐藏）

联调第 1 天发现，登录页（`/welcome`）上有两块东西和 cuberouter 身份矛盾：

| 位置 | 文案 | 代码 |
|---|---|---|
| 卡片顶部横幅 | 「注册即送 {count} Agent 任务体验 Token，开箱即用」 | `pages/welcome-page.tsx:92-106` |
| 卡片下方 | 「或」「使用自定义大模型 API Key（无需注册）」 | `pages/welcome-page.tsx:113-127` |

文案 key：`welcome.gift` / `welcome.or` / `welcome.byok.quickAction`（`i18n/messages.ts`）。

**横幅为什么会露出来**（这块要解释清楚，不然容易改错）：`showLoginBanner` 的第一个条件是 `canUseCloudFeatures(state)`，而它只看 `state.account.identityProvider !== "cuberouter"`——**未登录时那个字段的初始值是 `"memmy_cloud"`**（`state/app-reducer.ts:141`），所以登录前恒为 `true`。横幅的数字来自 memmy 云 `GET /api/memmy/desktop/promotions`（`adapters/outbound/cloud-client/http-cloud-client.ts:384`），与 cuberouter 无关。

**为什么必须隐藏**：cuberouter 身份下这份 token 根本发不出来——`isCuberouterSession()` 会跳过 `grantImprovementProgramTokens` 等云调用。横幅是空头承诺。

**决策（2026-09-18，先记不做）**

- **隐藏条件：新增构建期开关 `MEMMY_ACCOUNT_BACKEND`**（取值 `cuberouter` → 隐藏这两处）。语义是"这个构建的账号后端是谁"，比复用 `MEMMY_APP_EDITION` 准确：将来 cn 版也用 cuberouter、或 intl 版回到 memmy 云都不会判错。
- **第二处直接隐藏**，不做灰按钮——设置页的模型工作区仍能配自有 key，丢的只是"登录前免注册"这条捷径。

**已实现（2026-09-18）**

- `App/frontend/desktop/vite.config.ts` 的 `PUBLIC_MEMMY_RENDERER_ENV_KEYS` 加 `MEMMY_ACCOUNT_BACKEND`（该数组就是 define `import.meta.env.<KEY>`）。
- 新增 `app/account-backend.ts` 的 `isCuberouterAccountBackend()`。
- `pages/welcome-page.tsx`：横幅加 `!isCuberouterAccountBackend()` 条件；「或」分隔线 + BYOK 入口 + 反馈整段包进 `showCloudEntries`。
- `.env.example` 记录了开关（注释形式，默认不设）。
- 测试：新增 `pages/tests/welcome-page-cloud-entries.test.tsx`，用模块 mock 覆盖**两个分支**（隐藏 / 保留）。桌面 166 文件 / 1562 全绿。

**默认值决策**：不设 = **cuberouter**（即默认隐藏）。理由：这个分支的登录已经只有 cuberouter 一种（验证码流程已删），而横幅承诺的那份 token，cuberouter 身份根本拿不到（`isCuberouterSession` 会跳过云发放）—— 也就是**在所有构建里它都是空头承诺**。要恢复就显式设 `MEMMY_ACCOUNT_BACKEND=memmy_cloud`。这也是选"开关"而不是"直接删"的意义所在：将来真做回云账号时，一行就能拿回来。

### F5 注册支持邮箱验证（email + 验证码 + 发送按钮），由 flag 控制

**触发**：联调第 1 天，test.cuberouter.cn 开着 `EmailVerificationEnabled`，注册被服务端拒绝：`Email verification is enabled, please enter email address and verification code`。这正是 spec 里列为**非目标**的那一条（"目标实例默认关闭 Turnstile / 邮箱验证 / 2FA；这些情况只做错误提示，不做适配"）——所以现在这个报错是设计内的透传，不是 bug。

**服务端契约（已核实，来自 cuberouter 源码）**

- 注册体加两个字段：`email`、`verification_code`（`model/user.go:85,91` 的 json tag）。开启后缺任一个即拒（`controller/user.go:265`）。
- 送码接口：`GET /api/verification?email=<addr>`（`router/api-router.go:55`）。
- **限流：每 IP 30 秒最多 2 次**（`middleware/email-verification-rate-limit.go:14-15`），超限返回 **HTTP 429** + `发送过于频繁，请等待 N 秒后再试`。这是整条链路里**唯一的非 200 业务错误**——现有错误映射全按"HTTP 200 + `success:false`"设计，需要新增分支。
- 两个接口后面都挂 `middleware.TurnstileCheck()`，但只在 `TurnstileCheckEnabled` 时才拦。**目标实例已确认是关的**（能走到 handler 内部报错，说明中间件放行了）。
- **没有机器可读的错误码**：`ApiErrorI18n` 只发 `{success:false, message:"<本地化文案>"}`（`common/gin.go:223-228`），i18n key `user.email_verification_required`（`i18n/keys.go:90`）不出现在响应里。

**结论（2026-09-18 修订，已实现）**：**不用 flag，改成自动探测**。

`GET /api/status` 是公开接口，里面直接有 `email_verification` 和 `turnstile_check`（`controller/misc.go:58,75`）——cuberouter 自己的注册页就是这么判断的（`sign-up-form.tsx:102`）。实测目标实例：

```
email_verification  = True      ← 与撞上的报错完全对上
turnstile_check     = False
```

比 flag 好在哪：永远和实例真实配置一致（换服务器不用改任何东西），也不会出现"flag 关了但服务端要"这种自相矛盾的死局。原方案里"flag 只能靠文案匹配来自动切换"的矛盾随之消失。

**已交付**

- 契约：`CuberouterAuthInputSchema` 加可选 `email`/`verificationCode`；新增 `CuberouterRegistrationRequirementsSchema`、`CuberouterEmailCodeInputSchema`
- 适配器：`getRegistrationRequirements()`（读 `/api/status`，严格 `=== true`，缺字段 = false）、`sendEmailVerificationCode()`（`GET /api/verification?email=`）；`request()` 新增 `tooManyRequestsCode`，429 → 新错误码 `email_code_throttled`
- 服务/路由：`GET /api/account/registration-requirements`、`POST /api/account/email-code`；`email_code_throttled` → `rate_limited`（沿用 429，保留服务端"等待 N 秒"文案）
- 桌面：`useEmailVerificationCode()`（30s 倒计时，自排 timeout）、表单按需渲染 email + 验证码 + 发送按钮、`validateCredentials` 增 email/verificationCode 分支、中英各 8 条新 key
- 测试：后端 +15（112 文件/880），桌面 +10（165 文件/1560），双向 typecheck 干净

**降级路径**（都验证过）：实例不需要 → 表单和以前一模一样；探测失败 → 回退到不带这两个框的形态，注册时服务端拒绝就透传它的话。

**2026-09-18 补修**：探测失败原本是**静默**回退的，结果"环境没配对"和"服务端不需要"长得一模一样 —— 首次真机验证时正是这个把一次环境变量配错误导成了"功能没生效"（见记录表第 10 行）。现在探测失败会把服务端的原因显示在表单上（复用 `warning` 槽位），并保留 `console.warn`。

### F7 cuberouter 身份跳过导览后的昵称弹窗

**现象**：注册/首登后的引导末尾会弹昵称窗，初始值是随机名；但弹窗答案只落 `localStorage`（cuberouter 身份 `userMode=byok`，`persistNickname` 不走 `updateProfile`），**下次登录又被 profile 覆盖回用户名** —— 选了白选。

**根因**：昵称弹窗是云账号时代的设计（邮箱/手机号没有名字，随机一个）；它不知道 cuberouter 账号有用户名。登录时后端已把 `displayName`（注册时默认 = 用户名）写进 `account.nickname`（`cuberouter-account-service.ts:85`）。

**已实现（2026-09-18）**：`dismissProductTour`（`router.tsx`，"nickname" deferred step 的唯一写入点）加分支 —— `accountProvidesNickname(identityProvider)` 为真（cuberouter）时不再写 `"nickname"` deferred step，直接 `writeGuidanceCompleted` + 清 step + 进 `/main`，昵称就用账号的 displayName；云账号路径不变。埋点保留（nickname 步记 `choice: "account"` + `onboarding_completed`），漏斗不断。首次引导的其余部分（扫描权限、首扫报告、产品导览）**保留** —— 扫描权限真的配置功能。

- 测试：`nickname.test.ts` 谓词双分支 + `product-tour.test.tsx` 接线断言（AppRouter 无组件测试底座，与"cuberouter 去掉工具步"同法）。桌面 166 文件 / 1565 全绿。
- 真机验证：引导在每台机器只跑一次，已跑完的机器看不到差别。用 `scripts/clear-win-app-data.cmd` 清掉 `%APPDATA%\Memmy` 后注册新账号，走完导览应**直接进主界面、显示注册用户名**，无昵称弹窗。

### F8 引导完成状态不持久：每次登录重放产品导览

**现象**：注册 → 走完引导 → 退出登录 → 重新登录，**又出现产品导览**（且是从导览开始，不是从扫描权限）。

**取证**（`%APPDATA%\Memmy\app.sqlite`，只读查询）：

```
local-byok-onboarding: has_finished_guide=1, completed_at=2026-09-20T07:38:27Z   ← 完成写在这
cuberouter:10113:      has_finished_guide=0, current_step=scan_permission_required  ← 登录后读的是这行
user_mode=byok, active_uuid=cuberouter:10113
```

**根因（两个独立缺陷叠加）**

1. **作用域缺陷**（后端 `resolveOnboardingUuidWithDefaults`）：引导行按 `user_mode` 选 —— 只有**严格等于** `"byok"` 才用 `local-byok-onboarding`，`unset`（schema 默认值！）和 `account` 都落到 **active_uuid 那一行**。cuberouter 是"账号身份 + byok 模式"：完成写进了 local 行，而任何 `user_mode ≠ byok` 的启动读的是 `cuberouter:<id>` 行（永远未完成）。`unset` 时 `resolveInitialView` 还会直接落 `/welcome`——这也解释了"重启后为什么回到登录页"。
2. **陈旧快照缺陷**（前端 `continueAfterAuth`）：路由用**登录前**的 bootstrap 快照算，而它刚刚把模式写成 byok —— 本可以读回权威值（`updateOnboarding({})` 返回的就是全量重读）却没用，于是作用域不一致立刻变成"每次登录重放"。

两者叠加后，`first_encounter_report_status=shown` + 本地 `guidanceCompleted` 会让前端**跳过扫描/报告直接进产品导览**，与观察完全一致。

**已实现（2026-09-23）**

- 后端：`resolveOnboardingUuidWithDefaults` 加一条 —— **active_uuid 是 cuberouter 身份（`cuberouter:` 前缀）时，引导一律用自己的账号行**，不再看 `user_mode`；云账号路径不变。
- 前端：`persistLoginModeSelection` 返回读回的 onboarding，`continueAfterAuth` 用它（合并后）算路由，不再用登录前快照。

**升级代价（一次性）**：修好后 cuberouter 账号的引导改记在账号行，**旧的 local 行完成记录不再被认**——所以下次启动还会走一遍引导，走完即固化，之后不再重放。

- 测试：后端 +1（882 文件级 881），桌面 +1（1566），双向 typecheck 干净。

---

## 2. 联调记录

### 2.0 怎么打包（一条命令）

```bash
bash scripts/package-win-local.sh
```

它把下面这些坑全包了（补 `.env`、开镜像、关在跑的 Memmy、清 `win-unpacked`），并把参数原样转给 `package-win.sh`。想换 edition 或版本号就正常传 `--edition cn` / `--version 1.2.0`。加 `--prepare-only` 只做本地准备不打包。

### 2.1 怎么起（两条命令，按需选）

装好的包在 `App/shell/desktop/release/`：安装版 `Memmy-1.1.5-win32-x64-intl-unsigned.exe`，免安装版 `win-unpacked\Memmy.exe`。

**cmd（注意：不是 PowerShell）**

```cmd
set MEMMY_CUBEROUTER_URL=https://test.cuberouter.cn
set MEMMY_CUBEROUTER_MODEL=<该实例上真实存在的模型名>
"C:\Users\skeee\Downloads\memmy-agent\App\shell\desktop\release\win-unpacked\Memmy.exe"
```

**PowerShell（用 `$env:`，`set` 在这里是 `Set-Variable`，不会设环境变量）**

```powershell
$env:MEMMY_CUBEROUTER_URL = "https://test.cuberouter.cn"
$env:MEMMY_CUBEROUTER_MODEL = "<该实例上真实存在的模型名>"
$env:MEMMY_CUBEROUTER_URL          # 启动前确认一眼
& "C:\Users\skeee\Downloads\memmy-agent\App\shell\desktop\release\win-unpacked\Memmy.exe"
```

打本地就把 URL 换成 `http://127.0.0.1:3000`。

两种写法都只影响当前控制台且被 exe 继承，所以立刻生效、不用注销、不污染全局。

想固化成双击即用：仓库里已提交 `scripts/run-win-local.cmd` —— 就是上面 cmd 那几行的固化版，exe 路径用 `%~dp0` 相对定位，repo 克隆到哪都能跑。改变量 = 编辑这个文件里的两行 `set`。

注意赋值语句本身**没有回显**，所以启动前单独敲一行 `$env:MEMMY_CUBEROUTER_URL` 确认；四行必须在同一个窗口里。路径带空格时末尾命令的 `&` 不能省。

日志：`%APPDATA%\Memmy\logs\main.log`；模型配置：`C:\Users\skeee\.memmy\config.yaml`。

想重跑首次引导（比如验证 F7）：双击 `scripts/clear-win-app-data.cmd` —— 关 Memmy、删 `%APPDATA%\Memmy`（onboarding 状态、localStorage、会话、日志都在里面），**不动** `~/.memmy`（模型配置和 workspace 保留）。删完用 `run-win-local.cmd` 起，注册个新账号即是全新首次体验。

### 2.2 测之前先看：已知的坑

| # | 坑 | 现象 | 处理 |
|---|---|---|---|
| K1 | **旧会话会挡住注册界面** | 之前对着另一个服务端登录过，首屏不给注册表单 | cuberouter 会话不走服务端校验（`getSession` 短路），换服务端前先在设置里**退出登录** |
| K2 | **换服务端不会覆盖旧 endpoint** | config.yaml 里留着上一条 `apiBase` | 正常。`findExistingEndpointId` 按 apiBase 精确匹配，新服务端会**新增**一条 endpoint/preset；确认 assignments 指向新的那条即可 |
| K3 | ~~服务端协议与证书~~ **已确认（2026-09-18）** | `https://test.cuberouter.cn` 返回 200，证书有效（`tls_verify=0`）；`http://` 会 302 跳到 https | 统一写 `https://test.cuberouter.cn`，不用再验 |
| K4 | **模型名必须是目标实例上真实存在的** | 模型自检报"模型暂时不可用" | 自检是**非阻塞**的——账号和模型配置已经写好了，仍然会进主界面。换 `MEMMY_CUBEROUTER_MODEL` 重启即可。模型列表要登录后才看得到（`/api/models`、`/api/pricing` 都要鉴权，未登录探测不到） |
| K5 | **`setx` 不作用于已运行的 explorer** | 从开始菜单启动读不到变量 | 用上面的 `$env:`/`set` + 直接起 exe；或注销重登 |
| K6 | **PowerShell 里的 `set` 不是 cmd 的 `set`**（是 `Set-Variable` 别名，只建了个 PS 变量） | 变量没生效 → app 回落到默认 `http://127.0.0.1:3000` → 秒报「无法连接 cuberouter 服务」 | PowerShell 用 `$env:NAME = "..."`；同理 `export` 在 PowerShell 里也不存在 |
| K7 | **怎么区分"没连上"和"连上但超时"** | 两条都报同一句「无法连接 cuberouter 服务」 | 秒失败 = 连的是本机 `127.0.0.1:3000`（拒绝连接立即返回）；卡满 10 秒（`MEMMY_CUBEROUTER_TIMEOUT_MS` 默认值）才报 = 真的连上目标但超时 |
| K8 | **`prebuild-install` 拿不到 better-sqlite3 预编译包** | `prebuild-install warn install read ECONNRESET` / `Request timed out`，重试 3 次 + 兜底直连下载全挂 | 加 `MEMMY_PACKAGE_MIRROR=cn` 前缀重跑。已核实：prebuild-install 7.1.3 读的正是 `package-mirrors.sh` 设的 `npm_config_better_sqlite3_binary_host_mirror`（`util.js:68-71`），镜像上 `v12.11.1/electron-v139-win32-x64` 文件确实存在，且 `simple-get` 默认跟随 302 |
| K9 | **打包前没关掉正在运行的 App** | `EBUSY: resource busy or locked, unlink ...\release\win-unpacked\v8_context_snapshot.bin`，electron-builder 清不掉旧目录 | 关掉 `Memmy.exe`（含托盘残留）再打包：`Get-Process Memmy \| Stop-Process -Force`。**测的就是刚打出来的包，所以这条会反复出现** |
| K10 | **huggingface.co 下不动 embedding 模型** | `Embedding model download failed from https://huggingface.co/` 刷 3 次 | 通常**不是问题**：脚本会换下一个 host 重试（`prepare-embedding-model.mjs:92`），第二个 host 成功时是静默的。看到 `Bundled embedding model is ready` 就说明 `verifyModelFiles()` 已通过，文件是完整的 |

### 2.3 待验清单

- [ ] 注册新用户 → 一路进主界面，无卡死
- [ ] `config.yaml` 出现 `providers.openai.endpoints.<id>.apiBase = <URL>/v1`
- [ ] 模型自检通过（没有"模型暂时不可用"警告）
- [ ] 真的能对话一次（等 cuberouter 侧模型可用时补测）
- [ ] 退出登录 → 再登录 → **沿用同一个 token**（cuberouter 后台该用户 token 数不增加）
- [ ] 重启 app → 会话仍在（不被 `clearMismatchedActiveSession` 清掉）
- [ ] 工具页 / 首页 / 宠物页的云功能已按需隐藏，无报错
- [ ] 产品引导能走到最后一步（不被工具页守卫打断）
- [ ] 密码规则：8–20 位、含大小写字母和数字；用户名 ≤50

### 2.4 记录

| # | 时间 | 环境 | 做了什么 | 结果 | 证据 | 结论 / 后续 |
|---|---|---|---|---|---|---|
| 1 | 2026-09-18 | 开发机 → test.cuberouter.cn | 连通性预检 | `https://test.cuberouter.cn/api/status` → 200，证书有效；`http://` → 302 跳 https；`/api/models`、`/api/pricing` → 401（要鉴权） | `106.75.227.144`，`tls_verify=0` | 服务端可用，URL 用 https。模型名要登录后才知道 |
| 2 | 2026-09-18 | Windows 打包版 | 打开登录页看 UI | 顶部有「注册即送 …」横幅；卡片下方有「或 / 使用自定义大模型 API Key（无需注册）」 | 截图（用户口述） | 定制版都不要 → **F4**；已定方案（新增构建开关 `MEMMY_ACCOUNT_BACKEND`），**先不实现，接着测** |
| 3 | 2026-09-18 | Windows 打包版（PowerShell） | 设 `set MEMMY_CUBEROUTER_URL=...` 后启动，点注册 | 报「无法连接 cuberouter 服务，请检查服务地址与网络」；启动日志其余正常 | `main.log` 启动段 | 误因：**PowerShell 的 `set` 不设环境变量**（K6），app 回落到默认 `127.0.0.1:3000`。改用 `$env:` 重试 |
| 4 | 2026-09-18 | Windows 打包版 → test.cuberouter.cn | 用 `$env:` 重试，点注册 | **请求到达服务端**，服务端拒绝：`Email verification is enabled, please enter email address and verification code` | 界面提示 | 链路已通到注册接口；目标实例开了邮箱验证 → 记为 **F5** |
| 5 | 2026-09-18 | 开发机 | 实现 F5（自动探测，非 flag） | 后端 880/880、桌面 1560/1560、双向 typecheck 干净 | `npx vitest run` | 等重新打包后在 Windows 上验真机 |
| 6 | 2026-09-18 | Windows 打包版 | `git pull` 后重新打包 | pull 快进 22 文件无冲突；打包 4m25s 死在 vite 构建：`MEMMY_LEGAL_CN_BASE_URL must be an HTTPS origin without a path` | 打包日志 | 环境问题的第三次重演（shell 状态不进 git）→ 记为 **F6**，建 `.env` 后重试 |
| 7 | 2026-09-18 | Windows 打包版 | 补两行 legal 后重跑 | 过了 vite（4m48s），死在写 manifest：`MEMMY_CLOUD_SERVICE must be a non-empty HTTPS origin` | 打包日志 | F6 少了一个变量，`.env` 补到三行 |
| 8 | 2026-09-18 | Windows 打包版 | 三行 `.env` 后重跑 | 过了 manifest（5m04s），死在 better-sqlite3 预编译包下载：`ECONNRESET` + 超时，重试全挂 | 打包日志 | 网络问题 → **K8**，加 `MEMMY_PACKAGE_MIRROR=cn` 重跑 |
| 9 | 2026-09-18 | Windows 打包版 | 带镜像重跑 | 镜像生效（better-sqlite3 装好、native rebuild 通过），一路走到 electron-builder（7m00s），死在 `EBUSY ... v8_context_snapshot.bin` | 打包日志 | 在跑的 `win-unpacked\Memmy.exe` 锁住了旧目录 → **K9**，关进程 + 删目录后重跑 |
| 10 | 2026-09-18 | Windows 打包版 | 用 `set` 设变量后启动，打开注册页 | 页面**毫无变化**；`main.log` 里 `registration requirements probe failed ... 无法连接 cuberouter 服务` | `main.log` | **K6 第二次**：PowerShell 的 `set` 不设环境变量 → 探测打到 `127.0.0.1:3000` → 静默回退。改用 `$env:` 即可（探测代码本身没问题）。同时暴露了"静默回退"这个设计失误，已修 |
| 11 | 2026-09-18 | Windows 打包版 → test.cuberouter.cn | 用 `$env:` 启动 → 注册（含邮箱验证码）| **注册登录成功，进入主界面**。`config.yaml` 验证通过：`apiBase: https://test.cuberouter.cn/v1`、preset `model: kimi-k3-a` / `source: byok` / 三个 capabilities、`modelAssignments.byok.agent.default` 与 `agents.defaults.modelPreset` 均指向该 preset、`account.*` 全空、`app.userMode: byok` | `config.yaml` | **全链路打通**：注册 → 登录 → JWT → 建 token → 取明文 key → 写模型配置。残留：模型名是占位符，待换成实例上真实存在的 |
| 12 | 2026-09-18 | Windows 打包版 → test.cuberouter.cn | 注册成功后切到登录页登录 | **登录被前端拦下**：「请输入有效的邮箱地址」，但登录表单上根本没有邮箱框 | 页面反馈 | **真 bug**：面板把实例级探测结果 `emailVerificationRequired=true` 在登录模式也传给了校验器，而邮箱/验证码框只在注册模式渲染 → 登录永远过不了校验。已修（三个字段全部按 `mode === "register"` 收窄，与 confirmPassword 同一模式），回归测试钉死 |
| 13 | 2026-09-23 | Windows 打包版 → test.cuberouter.cn | 注册 → 走完引导 → 退出登录 → 再登录 | **产品导览又出现**；引导本该"每台机器一次" | `app.sqlite` 只读查询（引导行 + `app_settings`） | **真 bug，两个缺陷叠加**：① 引导行按 `user_mode` 选作用域（`unset`/`account` 都读账号行），完成写进了 local 行、读取却落在 `cuberouter:<id>` 行；② 登录后的路由用的是**登录前**的 bootstrap 快照。已修（作用域按身份 + 路由用读回值），见 **F8** |
| 14 | 2026-09-23 | Windows 打包版 | 反馈：首屏应该是**登录**，注册放下面当链接 | 已改：`AccountAuthPanel` 默认模式 `register` → **`login`**；注册入口就是按钮下方的「没有账号？去注册」 | 代码 | 一处默认值。表单本身双向对称、两句切换文案早就写好；改动波及 3 个测试文件（原来都假设注册优先），除适配外新增一条钉住"首屏=登录 + 切换可达注册"的用例 |

> 记法：**结果**只写观察到的事实，**结论**写判断和下一步。失败就把 `main.log` 的最后一段贴进来或指个位置。
