# 多节点线路选择 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面端在注册时把用户放到合适的那一个 cuberouter 节点上（大陆 / 香港），此后登录稳定回到同一节点，节点不可达时自动试另一边。

**Architecture:** 节点表是构建期配置（env → 可被 `config.yaml` 覆盖）；探测、选路、回退全在后端（Electron 主进程），前端只经本地 API 读探测结果并提交用户选择。当前线路存 `config.yaml` 的 `cuberouter.baseUrl`，"用户名 → 节点 id" 存 app 数据库。账号数据两地独立，所以线路是账号属性、注册时定终身。

**Tech Stack:** TypeScript（backend = Fastify + node:sqlite；desktop = React + vitest）、`yaml`、`@memmy/migrations` 的 `mutateRuntimeConfig`。

**Spec:** `docs/superpowers/specs/2026-09-23-multi-node-routing-design.md`

## Global Constraints

- 节点表格式：`MEMMY_CUBEROUTER_NODES=cn=https://cuberouter.cn,hk=https://cuberouter.com`；`config.yaml` 覆盖键是 `cuberouter.nodes`（与"当前线路" `cuberouter.baseUrl` **是两个键**）。
- 读取优先级：`MEMMY_CUBEROUTER_URL` 显式设置时**钉死该地址并完全关闭探测**；否则 env 值 > `config.yaml` > 节点表默认 > 现有默认（`http://127.0.0.1:3000`）。
- 探测：`GET <node>/api/status`，每节点 **2 次**取中位数，单次超时 **2000ms**，判据 **HTTP 200 且 JSON 含 `data`**（纯文本 404 视为不可用）。必须用 GET（HEAD 在健康节点上也返回 404）。
- 选路：单边可用→用它；两边可用→TTFB 差 ≥2 倍取快的，否则语言兜底（以 `zh` 开头 → `cn`，其它 → `hk`）；**都不可用 → `hk`**（`FALLBACK_NODE_ID`）。
- 持久化一律按**节点 id**（`cn`/`hk`），不按 URL。
- 登录回退：`记住的节点 → 当前线路 → 探测默认`去重后**最多试 2 个节点**，不重试。
- 记忆键是**规范化后的用户名**（`trim()`，不改变大小写 —— cuberouter 用户名大小写敏感）。
- 探测结果必须写日志（每节点：可用/不可用、耗时、判定依据）。
- 节点显示名走 i18n（`account.node.<id>`），不进节点表。
- 新增文件遵循现有风格：JSDoc 一行注释、`/** ... */` 文件头、测试与被测文件同构放在 `tests/` 子目录。

## Review Focus

以下是 spec 隐含、但单个任务的测试不容易覆盖到的输入/条件。每条都在**拥有该代码的任务**里配了测试：

1. **节点表为空或只有一个节点**（本地开发、单节点部署）—— 探测、回退、单选 UI 都必须退化成"没有选择"而不是报错。
2. **`config.yaml` 里 `cuberouter.baseUrl` 指向不在节点表里的地址**（用户手改过 / 节点表换了域名）—— 不能崩，按"没有当前线路"处理。
3. **探测还没落地就提交注册**（密码管理器一键填充）—— 必须被挡住，不能用一个未落地的默认值定终身。
4. **两个节点都是网络黑洞**（丢包而非拒绝）—— 探测最坏 4s（2 样本 × 2s 并行），登录最坏 `2 × MEMMY_CUBEROUTER_TIMEOUT_MS`；不能再乘倍数。
5. **用户名带首尾空白**（`" alice "`）—— 记忆表必须命中同一个 key，否则每次登录都两边试。

---

### Task 1: `config.yaml` 的 cuberouter 段（F1）

**Files:**
- Create: `App/backend/src/infrastructure/memmy-config/cuberouter-access.ts`
- Create: `App/backend/src/infrastructure/memmy-config/tests/cuberouter-access.test.ts`
- Modify: `App/backend/src/config/service-urls.ts`
- Modify: `App/backend/src/config/tests/service-urls.test.ts`
- Modify: `App/backend/src/index.ts:124-128`

**Interfaces:**
- Consumes: `mutateRuntimeConfig`（`@memmy/migrations`）、`YAML`（与 `agent-access.ts:59-69` 同一读取风格）
- Produces:
  - `interface CuberouterSettings { baseUrl?: string; model?: string; timeoutMs?: number }`
  - `readCuberouterSettings(configPath: string): Promise<CuberouterSettings>`
  - `writeCuberouterBaseUrl(configPath: string, baseUrl: string): Promise<void>`
  - `resolveCuberouterClientConfig(env: NodeJS.ProcessEnv, settings?: CuberouterSettings): CuberouterClientConfig`

- [ ] **Step 1: 写失败的测试**（`cuberouter-access.test.ts`）

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCuberouterSettings, writeCuberouterBaseUrl } from "../cuberouter-access.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function configWith(body: string): string {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-cuberouter-"));
  const configPath = join(tempDir, "config.yaml");
  writeFileSync(configPath, body, "utf8");
  return configPath;
}

describe("cuberouter config section", () => {
  it("reads baseUrl/model/timeoutMs from the cuberouter section", async () => {
    const configPath = configWith(
      "cuberouter:\n  baseUrl: https://cuberouter.cn\n  model: kimi-k3-a\n  timeoutMs: 20000\n"
    );
    expect(await readCuberouterSettings(configPath)).toEqual({
      baseUrl: "https://cuberouter.cn",
      model: "kimi-k3-a",
      timeoutMs: 20000
    });
  });

  it("returns an empty settings object for a missing section, a missing file, or bad types", async () => {
    expect(await readCuberouterSettings(configWith("agents:\n  defaults: {}\n"))).toEqual({});
    expect(await readCuberouterSettings(join(tmpdir(), "definitely-missing-config.yaml"))).toEqual({});
    expect(await readCuberouterSettings(configWith("cuberouter:\n  baseUrl: 42\n  timeoutMs: nope\n"))).toEqual({});
  });

  it("writes baseUrl without disturbing the rest of the file", async () => {
    const configPath = configWith("cuberouter:\n  model: kimi-k3-a\nagents:\n  defaults:\n    workspace: /tmp/w\n");
    await writeCuberouterBaseUrl(configPath, "https://cuberouter.com");

    expect(await readCuberouterSettings(configPath)).toEqual({
      baseUrl: "https://cuberouter.com",
      model: "kimi-k3-a"
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/backend -- src/infrastructure/memmy-config/tests/cuberouter-access.test.ts`
Expected: FAIL —— `Cannot find module '../cuberouter-access.js'`

- [ ] **Step 3: 实现 reader/writer**

```ts
/** cuberouter section of the runtime config. */
import { readFileSync } from "node:fs";
import { mutateRuntimeConfig } from "@memmy/migrations";
import YAML from "yaml";

export interface CuberouterSettings {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/** Reads the `cuberouter:` section; a missing section, file, or bad type yields no value. */
export async function readCuberouterSettings(configPath: string): Promise<CuberouterSettings> {
  try {
    return toSettings(record(record(YAML.parse(readFileSync(configPath, "utf8"))).cuberouter));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    return {};
  }
}

/** Writes the selected line, leaving every other key in the file untouched. */
export async function writeCuberouterBaseUrl(configPath: string, baseUrl: string): Promise<void> {
  await mutateRuntimeConfig(configPath, (root) => {
    const current = record(root.cuberouter);
    root.cuberouter = { ...current, baseUrl: baseUrl.replace(/\/+$/, "") };
  });
}

function toSettings(input: Record<string, unknown>): CuberouterSettings {
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : undefined;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
    ? input.timeoutMs
    : undefined;
  return {
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, "") } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs ? { timeoutMs } : {})
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/backend -- src/infrastructure/memmy-config/tests/cuberouter-access.test.ts`
Expected: PASS（3 条）

- [ ] **Step 5: 写失败的解析优先级测试**（加进 `src/config/tests/service-urls.test.ts`）

```ts
it("prefers env over the config file, and the config file over the defaults", () => {
  expect(resolveCuberouterClientConfig(
    { MEMMY_CUBEROUTER_URL: "https://env.example" },
    { baseUrl: "https://file.example" }
  ).baseUrl).toBe("https://env.example");

  expect(resolveCuberouterClientConfig(
    { MEMMY_CUBEROUTER_URL: "   " },
    { baseUrl: "https://file.example", model: "kimi-k3-a", timeoutMs: 20000 }
  )).toEqual({ baseUrl: "https://file.example", model: "kimi-k3-a", timeoutMs: 20000 });

  expect(resolveCuberouterClientConfig({})).toEqual({
    baseUrl: "http://127.0.0.1:3000",
    model: "deepseek-flash",
    timeoutMs: 10000
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npm run test -w @memmy/backend -- src/config/tests/service-urls.test.ts`
Expected: FAIL —— 第二个断言拿到默认值（`resolveCuberouterClientConfig` 还不接受第二个参数）

- [ ] **Step 7: 改 `service-urls.ts`**

```ts
/** Handles resolve cuberouter client config. Environment wins over the config file. */
export function resolveCuberouterClientConfig(
  env: NodeJS.ProcessEnv,
  settings: CuberouterSettings = {}
): CuberouterClientConfig {
  const baseUrl = env.MEMMY_CUBEROUTER_URL?.trim() || settings.baseUrl?.trim() || "http://127.0.0.1:3000";
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: env.MEMMY_CUBEROUTER_MODEL?.trim() || settings.model?.trim() || "deepseek-flash",
    timeoutMs: Number.parseInt(env.MEMMY_CUBEROUTER_TIMEOUT_MS ?? "", 10)
      || settings.timeoutMs
      || 10000
  };
}
```

（`import type { CuberouterSettings } from "../infrastructure/memmy-config/cuberouter-access.js";`）

- [ ] **Step 8: 跑测试确认通过，并接上 `index.ts`**

`App/backend/src/index.ts:124` 改为：

```ts
const cuberouterSettings = await readCuberouterSettings(memmyConfigPath);
const cuberouterConfig = resolveCuberouterClientConfig(process.env, cuberouterSettings);
```

Run: `npm run test -w @memmy/backend -- src/config/tests/service-urls.test.ts && npm run typecheck -w @memmy/backend`
Expected: PASS + 无类型错误

- [ ] **Step 9: 提交**

```bash
git add App/backend/src/infrastructure/memmy-config/cuberouter-access.ts \
  App/backend/src/infrastructure/memmy-config/tests/cuberouter-access.test.ts \
  App/backend/src/config/service-urls.ts App/backend/src/config/tests/service-urls.test.ts App/backend/src/index.ts
git commit -m "feat(config): read the cuberouter line from config.yaml"
```

---

### Task 2: 节点表

**Files:**
- Create: `App/backend/src/config/cuberouter-nodes.ts`
- Create: `App/backend/src/config/tests/cuberouter-nodes.test.ts`
- Modify: `App/backend/src/infrastructure/memmy-config/cuberouter-access.ts`（`CuberouterSettings` 加 `nodes`）

**Interfaces:**
- Consumes: Task 1 的 `readCuberouterSettings`
- Produces:
  - `interface CuberouterNode { id: string; url: string }`
  - `parseCuberouterNodeTable(raw: string): CuberouterNode[]`
  - `resolveCuberouterNodes(input: { env: NodeJS.ProcessEnv; settings?: CuberouterSettings }): CuberouterNode[]`

- [ ] **Step 1: 写失败的测试**

```ts
/** Node table tests. */
import { describe, expect, it } from "vitest";
import { parseCuberouterNodeTable, resolveCuberouterNodes } from "../cuberouter-nodes.js";

describe("cuberouter node table", () => {
  it("parses id=url pairs", () => {
    expect(parseCuberouterNodeTable("cn=https://cuberouter.cn,hk=https://cuberouter.com")).toEqual([
      { id: "cn", url: "https://cuberouter.cn" },
      { id: "hk", url: "https://cuberouter.com" }
    ]);
  });

  it("drops entries without an id, a url, or an http(s) scheme", () => {
    expect(parseCuberouterNodeTable("cn=,=https://x.example,hk=ftp://y.example,bad")).toEqual([]);
    expect(parseCuberouterNodeTable("  ")).toEqual([]);
  });

  it("lets the config file replace the environment, and survives an empty result", () => {
    const env = { MEMMY_CUBEROUTER_NODES: "cn=https://from-env.example" };
    expect(resolveCuberouterNodes({ env }).map((node) => node.id)).toEqual(["cn"]);
    expect(
      resolveCuberouterNodes({ env, settings: { nodes: [{ id: "hk", url: "https://from-file.example" }] } })
        .map((node) => node.id)
    ).toEqual(["hk"]);
    expect(resolveCuberouterNodes({ env: { MEMMY_CUBEROUTER_NODES: "" } })).toEqual([]);
  });

  it("pins to a single node when MEMMY_CUBEROUTER_URL is set, ignoring the table", () => {
    expect(resolveCuberouterNodes({
      env: {
        MEMMY_CUBEROUTER_URL: "http://127.0.0.1:3000/",
        MEMMY_CUBEROUTER_NODES: "cn=https://from-env.example,hk=https://other.example"
      }
    })).toEqual([{ id: "default", url: "http://127.0.0.1:3000" }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/backend -- src/config/tests/cuberouter-nodes.test.ts`
Expected: FAIL —— `Cannot find module '../cuberouter-nodes.js'`

- [ ] **Step 3: 实现**

```ts
/** Node table for multi-region deployments. */
import type { CuberouterSettings } from "../infrastructure/memmy-config/cuberouter-access.js";

export interface CuberouterNode {
  id: string;
  url: string;
}

/** Parses `id=url,id=url`; unusable entries are dropped rather than failing the whole table. */
export function parseCuberouterNodeTable(raw: string): CuberouterNode[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) return [];
      const id = entry.slice(0, separator).trim();
      const url = entry.slice(separator + 1).trim().replace(/\/+$/, "");
      return id && /^https?:\/\//.test(url) ? [{ id, url }] : [];
    });
}

/** Resolves the table: an explicit env URL pins the build to that single node, and the
 *  config file replaces the environment wholesale. */
export function resolveCuberouterNodes(input: {
  env: NodeJS.ProcessEnv;
  settings?: CuberouterSettings;
}): CuberouterNode[] {
  const pinned = input.env.MEMMY_CUBEROUTER_URL?.trim();
  if (pinned) {
    return [{ id: "default", url: pinned.replace(/\/+$/, "") }];
  }
  if (input.settings?.nodes?.length) {
    return input.settings.nodes;
  }
  return parseCuberouterNodeTable(input.env.MEMMY_CUBEROUTER_NODES ?? "");
}
```

`CuberouterSettings` 加 `nodes?: CuberouterNode[]`，并在 `toSettings` 里读 `input.nodes`（数组，逐项校验 `id` 为非空字符串、`url` 以 `http(s)://` 开头）。注意 `cuberouter-access.ts` 需要 `import type { CuberouterNode } from "../../config/cuberouter-nodes.js"` —— 若形成循环引用，把 `CuberouterNode` 定义移到 `cuberouter-access.ts` 并让 `cuberouter-nodes.ts` 从那里导入。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/backend -- src/config/tests/cuberouter-nodes.test.ts && npm run typecheck -w @memmy/backend`
Expected: PASS + 无类型错误（无循环引用报错）

- [ ] **Step 5: 提交**

```bash
git add App/backend/src/config/cuberouter-nodes.ts App/backend/src/config/tests/cuberouter-nodes.test.ts \
  App/backend/src/infrastructure/memmy-config/cuberouter-access.ts
git commit -m "feat(config): resolve the cuberouter node table"
```

---

### Task 3: 探测与选路

**Files:**
- Create: `App/backend/src/services/cuberouter-node-router.ts`
- Create: `App/backend/src/services/tests/cuberouter-node-router.test.ts`
- Modify: `App/backend/src/adapters/outbound/cuberouter-client/types.ts`（`CuberouterRegistrationRequirements` 加 `serverAddress: string | null`）
- Modify: `App/backend/src/adapters/outbound/cuberouter-client/http-cuberouter-client.ts`（`getRegistrationRequirements` 读 `server_address`）
- Modify: `App/backend/src/adapters/outbound/cuberouter-client/tests/http-cuberouter-client.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `CuberouterNode`；`CuberouterClient.getRegistrationRequirements()`
- Produces:
  - `interface NodeProbeEntry { nodeId: string; reachable: boolean; latencyMs: number | null }`
  - `interface NodeProbeResult { entries: NodeProbeEntry[]; defaultNodeId: string | null }`
  - `chooseDefaultNode(entries: readonly NodeProbeEntry[], language: string): string | null`（纯函数）
  - `createCuberouterNodeRouter(options): CuberouterNodeRouter`，其中
    `CuberouterNodeRouter = { probe(): Promise<NodeProbeResult>; listNodes(): readonly CuberouterNode[]; getNodeUrl(nodeId: string): string | null; getPreferredNodeId(): string | null; setPreferredNodeId(nodeId: string): Promise<void> }`
  - 常量 `PROBE_SAMPLES = 2`、`PROBE_TIMEOUT_MS = 2000`、`FALLBACK_NODE_ID = "hk"`

- [ ] **Step 1: 写失败的测试（先纯函数，后路由）**

```ts
/** Cuberouter node router tests. */
import { describe, expect, it, vi } from "vitest";
import { chooseDefaultNode, createCuberouterNodeRouter, type NodeProbeEntry } from "../cuberouter-node-router.js";

const entry = (nodeId: string, latencyMs: number | null): NodeProbeEntry => ({
  nodeId,
  reachable: latencyMs !== null,
  latencyMs
});

describe("chooseDefaultNode", () => {
  it("uses the only reachable node, whatever the latency", () => {
    expect(chooseDefaultNode([entry("cn", 120), entry("hk", null)], "en-US")).toBe("cn");
  });

  it("takes the clearly faster node when the gap is at least 2x", () => {
    expect(chooseDefaultNode([entry("cn", 120), entry("hk", 480)], "en-US")).toBe("cn");
    expect(chooseDefaultNode([entry("cn", 500), entry("hk", 130)], "zh-CN")).toBe("hk");
  });

  it("falls back to the language when the gap is under 2x", () => {
    expect(chooseDefaultNode([entry("cn", 200), entry("hk", 300)], "zh-CN")).toBe("cn");
    expect(chooseDefaultNode([entry("cn", 200), entry("hk", 300)], "en-US")).toBe("hk");
  });

  it("returns null when nothing is reachable", () => {
    expect(chooseDefaultNode([entry("cn", null), entry("hk", null)], "zh-CN")).toBeNull();
    expect(chooseDefaultNode([], "zh-CN")).toBeNull();
  });
});

describe("cuberouter node router", () => {
  const nodes = [
    { id: "cn", url: "https://cn.example" },
    { id: "hk", url: "https://hk.example" }
  ];

  it("probes twice per node, keeps the median, and logs every attempt", async () => {
    const latencies: Record<string, number[]> = { "https://cn.example": [300, 100], "https://hk.example": [500, 700] };
    const clientFor = vi.fn((url: string) => ({
      getRegistrationRequirements: async () => {
        const value = latencies[url].shift()!;
        await new Promise((resolve) => setTimeout(resolve, value / 50));
        return { emailVerificationRequired: false, turnstileRequired: false, serverAddress: url };
      }
    }));
    const log = vi.fn();
    const router = createCuberouterNodeRouter({
      nodes,
      clientFor: clientFor as never,
      readPreferredNodeId: async () => null,
      writePreferredNodeId: async () => undefined,
      language: () => "en-US",
      log
    });

    const result = await router.probe();

    expect(clientFor).toHaveBeenCalledTimes(2);
    expect(result.entries.every((item) => item.reachable)).toBe(true);
    // 2 samples each; cn's median is below hk's, so cn wins despite the first sample being slower
    expect(result.defaultNodeId).toBe("cn");
    expect(log).toHaveBeenCalled();
  });

  it("treats a rejected status call as unreachable and never throws", async () => {
    const router = createCuberouterNodeRouter({
      nodes,
      clientFor: ((url: string) => ({
        getRegistrationRequirements: async () => {
          if (url.includes("cn")) throw Object.assign(new Error("rejected"), { code: "rejected" });
          return { emailVerificationRequired: false, turnstileRequired: false, serverAddress: null };
        }
      })) as never,
      readPreferredNodeId: async () => null,
      writePreferredNodeId: async () => undefined,
      language: () => "zh-CN",
      log: vi.fn()
    });

    const result = await router.probe();

    expect(result.entries).toEqual([
      { nodeId: "cn", reachable: false, latencyMs: null },
      { nodeId: "hk", reachable: true, latencyMs: expect.any(Number) }
    ]);
    expect(result.defaultNodeId).toBe("hk");
  });

  it("resolves a node url and rejects an unknown id", () => {
    const router = createCuberouterNodeRouter({
      nodes,
      clientFor: (() => ({})) as never,
      readPreferredNodeId: async () => null,
      writePreferredNodeId: async () => undefined,
      language: () => "zh-CN",
      log: vi.fn()
    });

    expect(router.getNodeUrl("hk")).toBe("https://hk.example");
    expect(router.getNodeUrl("nope")).toBeNull();
    expect(router.listNodes().map((node) => node.id)).toEqual(["cn", "hk"]);
  });

  it("sends no probe traffic when there is only one node (pinned URL or single-node build)", async () => {
    const clientFor = vi.fn();
    const router = createCuberouterNodeRouter({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }],
      clientFor: clientFor as never,
      readPreferredNodeId: async () => null,
      writePreferredNodeId: async () => undefined,
      language: () => "zh-CN",
      log: vi.fn()
    });

    const result = await router.probe();

    expect(clientFor).not.toHaveBeenCalled();
    expect(result.defaultNodeId).toBe("default");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/backend -- src/services/tests/cuberouter-node-router.test.ts`
Expected: FAIL —— `Cannot find module '../cuberouter-node-router.js'`

- [ ] **Step 3: 实现**

```ts
/** Probes the configured cuberouter nodes and picks the line to use. */
import type { CuberouterNode } from "../config/cuberouter-nodes.js";
import type { CuberouterClient } from "../adapters/outbound/cuberouter-client/index.js";

export const PROBE_SAMPLES = 2;
export const PROBE_TIMEOUT_MS = 2000;
/** Used when nothing is reachable: the probe has no information, so no guessing happens beyond this. */
export const FALLBACK_NODE_ID = "hk";

export interface NodeProbeEntry {
  nodeId: string;
  reachable: boolean;
  latencyMs: number | null;
}

export interface NodeProbeResult {
  entries: NodeProbeEntry[];
  defaultNodeId: string | null;
}

/** Two nearby latencies are noise, so the language prior only applies inside this factor. */
const LATENCY_DECISIVE_FACTOR = 2;

/** For this build's node ids: Chinese UI leans mainland, everything else leans Hong Kong. */
function languagePreferredNodeId(language: string): string {
  return language.toLowerCase().startsWith("zh") ? "cn" : FALLBACK_NODE_ID;
}

/** Picks the default line from measured results. Pure, so the rule is testable on its own. */
export function chooseDefaultNode(entries: readonly NodeProbeEntry[], language: string): string | null {
  const reachable = entries.filter((entry) => entry.reachable && entry.latencyMs !== null);
  if (reachable.length === 0) return null;
  if (reachable.length === 1) return reachable[0]!.nodeId;

  const sorted = [...reachable].sort((left, right) => left.latencyMs! - right.latencyMs!);
  const fastest = sorted[0]!;
  const slowest = sorted[sorted.length - 1]!;
  if (fastest.latencyMs! * LATENCY_DECISIVE_FACTOR <= slowest.latencyMs!) {
    return fastest.nodeId;
  }

  const preferred = languagePreferredNodeId(language);
  return reachable.some((entry) => entry.nodeId === preferred) ? preferred : fastest.nodeId;
}

export interface CuberouterNodeRouter {
  probe(): Promise<NodeProbeResult>;
  listNodes(): readonly CuberouterNode[];
  getNodeUrl(nodeId: string): string | null;
  getPreferredNodeId(): string | null;
  setPreferredNodeId(nodeId: string): Promise<void>;
}

export interface CreateCuberouterNodeRouterOptions {
  nodes: readonly CuberouterNode[];
  clientFor: (url: string) => CuberouterClient;
  readPreferredNodeId: () => Promise<string | null>;
  writePreferredNodeId: (nodeId: string) => Promise<void>;
  language: () => string;
  log: (message: string) => void;
  now?: () => number;
}

export function createCuberouterNodeRouter(options: CreateCuberouterNodeRouterOptions): CuberouterNodeRouter {
  const now = options.now ?? Date.now;

  async function measure(node: CuberouterNode): Promise<NodeProbeEntry> {
    const samples: number[] = [];
    const client = options.clientFor(node.url);
    for (let attempt = 0; attempt < PROBE_SAMPLES; attempt += 1) {
      const startedAt = now();
      try {
        const status = await client.getRegistrationRequirements({ timeoutMs: PROBE_TIMEOUT_MS });
        samples.push(now() - startedAt);
        // Soft check: the node names itself. A mismatch means something rewrote the route; it never blocks.
        if (status.serverAddress && !node.url.startsWith(status.serverAddress.replace(/\/+$/, ""))) {
          options.log(`[cuberouter] node ${node.id} answers for ${status.serverAddress} (configured ${node.url})`);
        }
      } catch (error) {
        options.log(`[cuberouter] probe ${node.id} (${node.url}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (samples.length === 0) {
      return { nodeId: node.id, reachable: false, latencyMs: null };
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const latencyMs = sorted[Math.floor(sorted.length / 2)]!;
    options.log(`[cuberouter] probe ${node.id} (${node.url}) reachable in ${latencyMs}ms`);
    return { nodeId: node.id, reachable: true, latencyMs };
  }

  return {
    async probe() {
      // A single node has nothing to choose between, so no probe traffic is sent at all
      // (this is the pinned-URL case and single-node builds).
      if (options.nodes.length <= 1) {
        const only = options.nodes[0];
        return { entries: [], defaultNodeId: only?.id ?? null };
      }

      const entries = await Promise.all(options.nodes.map((node) => measure(node)));
      const defaultNodeId = chooseDefaultNode(entries, options.language());
      options.log(
        `[cuberouter] probe result: ${entries.map((entry) => `${entry.nodeId}=${entry.reachable ? `${entry.latencyMs}ms` : "unreachable"}`).join(", ")} → default ${defaultNodeId ?? FALLBACK_NODE_ID}`
      );
      return { entries, defaultNodeId };
    },

    listNodes() {
      return options.nodes;
    },

    getNodeUrl(nodeId) {
      return options.nodes.find((node) => node.id === nodeId)?.url ?? null;
    },

    async getPreferredNodeId() {
      return await options.readPreferredNodeId();
    },

    async setPreferredNodeId(nodeId) {
      await options.writePreferredNodeId(nodeId);
    }
  };
}
```

`getRegistrationRequirements` 需要接受可选超时并返回 `serverAddress`：

- `types.ts`：`getRegistrationRequirements(options?: { timeoutMs?: number }): Promise<CuberouterRegistrationRequirements>`；`CuberouterRegistrationRequirements` 加 `serverAddress: string | null`
- `http-cuberouter-client.ts`：

```ts
    async getRegistrationRequirements(probeOptions) {
      const data = await request<Record<string, unknown>>(
        fetchImpl, baseUrl, probeOptions?.timeoutMs ?? options.timeoutMs, "/api/status", { method: "GET" }
      );
      return {
        emailVerificationRequired: data.email_verification === true,
        turnstileRequired: data.turnstile_check === true,
        serverAddress: readString(data.server_address)
      };
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/backend -- src/services/tests/cuberouter-node-router.test.ts src/adapters/outbound/cuberouter-client/tests/http-cuberouter-client.test.ts`
Expected: PASS（新 7 条 + 现有全部）。现有 `getRegistrationRequirements` 的断言需要补 `serverAddress`

- [ ] **Step 5: 提交**

```bash
git add App/backend/src/services/cuberouter-node-router.ts App/backend/src/services/tests/cuberouter-node-router.test.ts \
  App/backend/src/adapters/outbound/cuberouter-client/
git commit -m "feat(cuberouter): probe nodes and choose the default line"
```

---

### Task 4: 账号归属记忆（用户名 → 节点 id）

**Files:**
- Create: `App/backend/src/infrastructure/app-state-store/migrations/0029-cuberouter-account-node.sql`
- Create: `App/backend/src/infrastructure/app-state-store/repositories/cuberouter-account-node-repo.ts`
- Create: `App/backend/src/infrastructure/app-state-store/tests/cuberouter-account-node-repo.test.ts`
- Modify: `App/backend/src/infrastructure/app-state-store/index.ts`（挂进 `repositories`）

**Interfaces:**
- Produces:
  - `interface CuberouterAccountNodeRepository { get(username: string): string | null; set(username: string, nodeId: string): void }`
  - `createCuberouterAccountNodeRepository(db: DatabaseSync): CuberouterAccountNodeRepository`
  - **`normalizeCuberouterUsername(username: string): string`** —— `trim()`，不改大小写（cuberouter 用户名大小写敏感）

- [ ] **Step 1: 写失败的测试**

```ts
/** Cuberouter account node memory tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("cuberouter account node memory", () => {
  it("remembers the line per username and survives reopening", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-node-memory-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    expect(store.repositories.cuberouterAccountNode.get("alice")).toBeNull();
    store.repositories.cuberouterAccountNode.set("  alice  ", "cn");
    store.close();

    const reloaded = createAppStateStore({ databasePath });
    // Whitespace is trimmed on both sides, so a padded login name still hits its own row.
    expect(reloaded.repositories.cuberouterAccountNode.get("alice")).toBe("cn");
    expect(reloaded.repositories.cuberouterAccountNode.get("  alice")).toBe("cn");
    reloaded.repositories.cuberouterAccountNode.set("alice", "hk");
    expect(reloaded.repositories.cuberouterAccountNode.get("alice")).toBe("hk");
    reloaded.close();
  });

  it("keeps usernames case-sensitive", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-node-memory-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });
    store.repositories.cuberouterAccountNode.set("Alice", "cn");

    expect(store.repositories.cuberouterAccountNode.get("alice")).toBeNull();
    store.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/backend -- src/infrastructure/app-state-store/tests/cuberouter-account-node-repo.test.ts`
Expected: FAIL —— `repositories.cuberouterAccountNode` 未定义

- [ ] **Step 3: 写迁移、repo 并挂载**

`0029-cuberouter-account-node.sql`：

```sql
-- Which cuberouter node an account was registered on. The two deployments keep
-- separate accounts, so this is what lets a later login come back to the right one.
CREATE TABLE IF NOT EXISTS cuberouter_account_node (
  username TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

repo：

```ts
/** Remembers which cuberouter node an account belongs to. */
import type { DatabaseSync } from "node:sqlite";

export interface CuberouterAccountNodeRepository {
  get(username: string): string | null;
  set(username: string, nodeId: string): void;
}

/** Trims only: cuberouter usernames are case-sensitive, so folding case would merge two accounts. */
export function normalizeCuberouterUsername(username: string): string {
  return username.trim();
}

export function createCuberouterAccountNodeRepository(db: DatabaseSync): CuberouterAccountNodeRepository {
  return {
    get(username) {
      const row = db
        .prepare("SELECT node_id FROM cuberouter_account_node WHERE username = ?")
        .get(normalizeCuberouterUsername(username)) as { node_id: string } | undefined;
      return row?.node_id ?? null;
    },

    set(username, nodeId) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO cuberouter_account_node (username, node_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET node_id = excluded.node_id, updated_at = excluded.updated_at`
      ).run(normalizeCuberouterUsername(username), nodeId, now, now);
    }
  };
}
```

在 `index.ts` 的 `repositories` 对象里加 `cuberouterAccountNode: createCuberouterAccountNodeRepository(db),`，并在 `AppStateStore` 类型里补该字段。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/backend -- src/infrastructure/app-state-store/tests/cuberouter-account-node-repo.test.ts src/infrastructure/app-state-store/tests/index.test.ts`
Expected: PASS（新 2 条 + 现有全部）

- [ ] **Step 5: 提交**

```bash
git add App/backend/src/infrastructure/app-state-store/
git commit -m "feat(app-state): remember the cuberouter node per account"
```

---

### Task 5: 注册带线路、登录带回退

**Files:**
- Modify: `App/backend/local-api-contracts/src/index.ts`（`CuberouterAuthInputSchema` 加 `nodeId`；新增 `CuberouterNodesViewSchema`、`CuberouterNodeProbeViewSchema`）
- Modify: `App/backend/src/services/cuberouter-account-service.ts`
- Modify: `App/backend/src/services/tests/cuberouter-account-service.test.ts`
- Modify: `App/backend/src/services/index.ts`（装配 node router 与 repo）

**Interfaces:**
- Consumes: Task 3 的 `CuberouterNodeRouter`、Task 4 的 `CuberouterAccountNodeRepository`、Task 1 的 `writeCuberouterBaseUrl`
- Produces（服务接口变化）：
  - `register(input: CuberouterAuthInput & { nodeId?: string }): Promise<CuberouterAuthResult>`
  - `login(input: { username: string; password: string }): Promise<CuberouterAuthResult>`（内部回退）
  - `getRegistrationRequirements(nodeId?: string): Promise<CuberouterRegistrationRequirements>`（跟随指定线路重新读取）
  - `getNodes(): Promise<{ nodes: string[]; currentNodeId: string | null }>`
  - `probeNodes(): Promise<{ nodes: string[]; defaultNodeId: string | null }>`

- [ ] **Step 1: 写失败的测试**（加进 `cuberouter-account-service.test.ts`）

```ts
it("registers on the node the caller picked, and remembers it", async () => {
  const registeredOn: string[] = [];
  const remembered: Array<[string, string]> = [];
  const service = createTestService({
    nodes: [
      { id: "cn", url: "https://cn.example" },
      { id: "hk", url: "https://hk.example" }
    ],
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
    .rejects.toThrow(/线路/);
});

it("logs in on the remembered node first, and falls back to the other one", async () => {
  const attempts: string[] = [];
  const service = createTestService({
    nodes: [
      { id: "cn", url: "https://cn.example" },
      { id: "hk", url: "https://hk.example" }
    ],
    rememberedNodeId: "cn",
    onLogin: (url) => {
      attempts.push(url);
      if (url === "https://cn.example") throw Object.assign(new Error("无法连接"), { code: "service_unavailable" });
    }
  });

  const result = await service.login({ username: "alice", password: "Passw0rd1" });

  expect(attempts).toEqual(["https://cn.example", "https://hk.example"]);
  expect(result.session.authenticated).toBe(true);
});

it("stops after two attempts and keeps the node it succeeded on", async () => {
  const attempts: string[] = [];
  const remembered: Array<[string, string]> = [];
  const service = createTestService({
    nodes: [
      { id: "cn", url: "https://cn.example" },
      { id: "hk", url: "https://hk.example" }
    ],
    rememberedNodeId: "hk",
    preferredNodeId: "cn",
    onLogin: (url) => attempts.push(url),
    onRemember: (username, nodeId) => remembered.push([username, nodeId])
  });

  await service.login({ username: "alice", password: "Passw0rd1" });

  // hk first (remembered), then cn (preferred) — the default probe result is never reached.
  expect(attempts).toEqual(["https://hk.example", "https://cn.example"]);
  expect(remembered).toEqual([["alice", "hk"]]);
});

it("surfaces the last failure when neither node accepts the credentials", async () => {
  const service = createTestService({
    nodes: [
      { id: "cn", url: "https://cn.example" },
      { id: "hk", url: "https://hk.example" }
    ],
    onLogin: () => {
      throw Object.assign(new Error("用户名或密码错误"), { code: "rejected" });
    }
  });

  await expect(service.login({ username: "alice", password: "Passw0rd1" })).rejects.toThrow("用户名或密码错误");
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

it("reads the registration requirements from the node the caller is looking at", async () => {
  const asked: string[] = [];
  const service = createTestService({
    nodes: [
      { id: "cn", url: "https://cn.example" },
      { id: "hk", url: "https://hk.example" }
    ],
    onRequirements: (url) => asked.push(url)
  });

  expect(await service.getRegistrationRequirements("hk")).toEqual({
    emailVerificationRequired: true,
    turnstileRequired: false,
    serverAddress: "https://hk.example"
  });
  expect(asked).toEqual(["https://hk.example"]);
});
```

`createTestService` 的完整实现（本任务新增，放在测试文件底部）：

```ts
function createTestService(input: {
  nodes: Array<{ id: string; url: string }>;
  rememberedNodeId?: string | null;
  preferredNodeId?: string | null;
  probeDefaultNodeId?: string | null;
  onRegister?: (url: string) => void;
  onLogin?: (url: string) => void;
  onRequirements?: (url: string) => void;
  onRemember?: (username: string, nodeId: string) => void;
}) {
  const remembered = new Map<string, string>();
  if (input.rememberedNodeId) remembered.set("alice", input.rememberedNodeId);
  const preferred = input.preferredNodeId ?? null;

  return createCuberouterAccountService({
    accountSessionRepository: {
      upsert: (payload: { profile: { userId: string; nickname: string | null } }) => ({
        authenticated: true,
        isNewUser: false,
        profile: { userId: payload.profile.userId, nickname: payload.profile.nickname }
      }),
      clear: () => undefined
    } as never,
    accountNodes: {
      get: (username: string) => remembered.get(username.trim()) ?? null,
      set: (username: string, nodeId: string) => {
        remembered.set(username.trim(), nodeId);
        input.onRemember?.(username, nodeId);
      }
    },
    nodeRouter: {
      probe: async () => ({ entries: [], defaultNodeId: input.probeDefaultNodeId ?? null }),
      listNodes: () => input.nodes,
      getNodeUrl: (nodeId: string) => input.nodes.find((node) => node.id === nodeId)?.url ?? null,
      getPreferredNodeId: async () => preferred,
      setPreferredNodeId: async () => undefined
    },
    clientFor: (url: string) => ({
      register: async () => {
        input.onRegister?.(url);
      },
      login: async () => {
        input.onLogin?.(url);
        return { accessToken: "jwt", userId: "10113", username: "alice", displayName: "alice" };
      },
      getRegistrationRequirements: async () => {
        input.onRequirements?.(url);
        return { emailVerificationRequired: true, turnstileRequired: false, serverAddress: url };
      },
      listTokens: async () => [],
      createToken: async () => undefined,
      getTokenKey: async () => "sk-cuberouter",
      getSelf: async () => ({ userId: "10113", username: "alice", displayName: "alice", quota: 0 })
    }) as never,
    model: "deepseek-flash",
    log: () => undefined
  });
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/backend -- src/services/tests/cuberouter-account-service.test.ts`
Expected: FAIL —— `register` 不接受 `nodeId`；`login` 只试一次

- [ ] **Step 3: 改契约与服务**

契约（`local-api-contracts/src/index.ts`）：

```ts
export const CuberouterAuthInputSchema = z.object({
    username: z.string().trim().min(1).max(50),
    password: z.string().min(8).max(20),
    email: z.string().trim().email().max(50).optional(),
    verificationCode: z.string().trim().min(1).max(20).optional(),
    /** 注册时选定的线路；缺省时后端用探测默认值。 */
    nodeId: z.string().trim().min(1).max(32).optional()
});

/** 可选线路与当前生效线路。 */
export const CuberouterNodesViewSchema = z.object({
    nodes: z.array(z.string()),
    currentNodeId: z.string().nullable()
});

/** 探测结果：默认该用哪条线路。 */
export const CuberouterNodeProbeViewSchema = z.object({
    nodes: z.array(z.string()),
    defaultNodeId: z.string().nullable()
});
```

服务（`cuberouter-account-service.ts`）：依赖换成 `{ clientFor, accountSessionRepository, accountNodes, nodeRouter, model }`，并把 `completeLogin` 改成接受一个已选定的 node：

```ts
  /** Runs one register/login round against one node and returns its client. */
  function clientForNode(nodeId: string): { client: CuberouterClient; url: string } {
    const url = options.nodeRouter.getNodeUrl(nodeId);
    if (!url) {
      throw Object.assign(new Error("未知的线路"), { code: "invalid_argument" as const });
    }
    return { client: options.clientFor(url), url };
  }

  /** Login candidate order: remembered → current line → probe default, at most two nodes. */
  async function loginOrder(username: string): Promise<string[]> {
    const remembered = options.accountNodes.get(username);
    const preferred = await options.nodeRouter.getPreferredNodeId();
    const probed = (await options.nodeRouter.probe()).defaultNodeId;
    const ordered = [remembered, preferred, probed, FALLBACK_NODE_ID].filter(
      (nodeId): nodeId is string => Boolean(nodeId) && options.nodeRouter.getNodeUrl(nodeId!) !== null
    );
    return [...new Set(ordered)].slice(0, 2);
  }

  async function loginOnNode(nodeId: string, username: string, password: string): Promise<CuberouterAuthResult> {
    const { client, url } = clientForNode(nodeId);
    const session = await client.login({ username, password });
    const apiKey = await ensureApiKey(client, session.accessToken);
    const projection = options.accountSessionRepository.upsert({ /* 同现有 completeLogin 的载荷 */ });
    options.accountNodes.set(username, nodeId);
    await options.nodeRouter.setPreferredNodeId(nodeId);
    options.log(`[cuberouter] logged in on ${nodeId} (${url})`);
    return {
      session: projection,
      provisioning: { apiKey, apiBase: `${url}/v1`, model: options.model }
    };
  }
```

`login()`：按 `loginOrder` 逐个 `loginOnNode`，把最后一次错误抛出（`throw lastError`）。`register()`：`nodeId = input.nodeId ?? (await options.nodeRouter.probe()).defaultNodeId ?? FALLBACK_NODE_ID`，然后注册 + `loginOnNode`。

`getRegistrationRequirements(nodeId?)`：目标节点 = 显式 `nodeId` ?? 当前线路 ?? 探测默认 ?? `FALLBACK_NODE_ID`，经 `clientForNode` 取 URL 后调用。**两个节点的注册要求（邮箱验证 / Turnstile）可以不同**，所以这条必须按用户当前看着的那条线路读，而不是沿用上一次结果。`getNodes()` 返回 `{ nodes: nodeRouter.listNodes().map((node) => node.id), currentNodeId }`；`probeNodes()` 返回 `{ nodes: 同上, defaultNodeId: (await nodeRouter.probe()).defaultNodeId }`。

`services/index.ts` 里装配：用 `resolveCuberouterNodes({env, settings})` 建 router（`clientFor: (url) => createHttpCuberouterClient({ baseUrl: url, timeoutMs })`，`readPreferredNodeId` 从 `config.yaml` 的 baseUrl 反查节点 id，`writePreferredNodeId` → `writeCuberouterBaseUrl(configPath, url)`，`language` 取自 app 设置，`log: console.info`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/backend -- src/services/tests/cuberouter-account-service.test.ts && npm run typecheck -w @memmy/backend`
Expected: PASS（新 5 条 + 现有全部）

- [ ] **Step 5: 提交**

```bash
git add App/backend/local-api-contracts/src/index.ts App/backend/src/services/
git commit -m "feat(cuberouter): register on the chosen line and fail over at login"
```

---

### Task 6: 本地 API 与前端客户端

**Files:**
- Modify: `App/backend/src/adapters/inbound/local-api/routes/account.ts`
- Modify: `App/backend/src/adapters/inbound/local-api/tests/account-routes.test.ts`
- Modify: `App/frontend/desktop/src/api/account-client.ts`
- Modify: `App/frontend/desktop/src/api/tests/account-client.test.ts`（若无则跳过该文件，只改实现）

**Interfaces:**
- Consumes: Task 5 的 `getNodes()` / `probeNodes()`
- Produces:
  - `GET /api/account/nodes` → `CuberouterNodesView`
  - `POST /api/account/nodes/probe` → `CuberouterNodeProbeView`
  - `AccountClient.getNodes(): Promise<CuberouterNodesView>`
  - `AccountClient.probeNodes(): Promise<CuberouterNodeProbeView>`

- [ ] **Step 1: 写失败的路由测试**

```ts
it("serves the node list, the current line, and the probe default", async () => {
  const app = await createServer({
    cuberouterAccount: {
      ...baseCuberouterAccount,
      getNodes: async () => ({ nodes: ["cn", "hk"], currentNodeId: "cn" }),
      probeNodes: async () => ({ nodes: ["cn", "hk"], defaultNodeId: "hk" })
    }
  });

  const nodes = await app.inject({ method: "GET", url: "/api/account/nodes" });
  const probe = await app.inject({ method: "POST", url: "/api/account/nodes/probe" });

  expect(nodes.json()).toEqual({ nodes: ["cn", "hk"], currentNodeId: "cn" });
  expect(probe.json()).toEqual({ nodes: ["cn", "hk"], defaultNodeId: "hk" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/backend -- src/adapters/inbound/local-api/tests/account-routes.test.ts`
Expected: FAIL —— 404（路由未注册）

- [ ] **Step 3: 加路由与前端客户端**

后端（`account.ts`，两条都挂 `authenticateRuntimeToken`）：

```ts
  app.get(
    "/api/account/nodes",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = CuberouterNodesViewSchema.parse(await options.cuberouterAccount.getNodes());
      return reply.send(response);
    })
  );

  app.post(
    "/api/account/nodes/probe",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = CuberouterNodeProbeViewSchema.parse(await options.cuberouterAccount.probeNodes());
      return reply.send(response);
    })
  );
```

现有的 `/api/account/registration-requirements` 加上可选的线路参数（两个节点的要求可以不同）：

```ts
  app.get(
    "/api/account/registration-requirements",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const nodeId = CuberouterNodeIdQuerySchema.parse(request.query).nodeId;
      const response = CuberouterRegistrationRequirementsSchema.parse(
        await options.cuberouterAccount.getRegistrationRequirements(nodeId)
      );
      return reply.send(response);
    })
  );
```

契约里加：`export const CuberouterNodeIdQuerySchema = z.object({ nodeId: z.string().trim().min(1).max(32).optional() });`

前端（`account-client.ts`）：

```ts
  /** Reads the configured lines and the one currently in effect. */
  async getNodes() {
    return await requestJson<CuberouterNodesView>("/api/account/nodes", { method: "GET" });
  },

  /** Asks the backend to measure every line; slow (up to ~4s), so call it on mount only. */
  async probeNodes() {
    return await requestJson<CuberouterNodeProbeView>("/api/account/nodes/probe", { method: "POST" });
  },
```

已有的 `getRegistrationRequirements()` 增加可选线路并透传为查询参数：

```ts
  async getRegistrationRequirements(nodeId?: string) {
    const query = nodeId ? `?${new URLSearchParams({ nodeId }).toString()}` : "";
    return await requestJson<CuberouterRegistrationRequirements>(
      `/api/account/registration-requirements${query}`,
      { method: "GET" }
    );
  },
```

（`register`/`login` 的入参类型改为带上 `nodeId`：`CuberouterAuthInputSchema` 已经允许，前端 `register(input: CuberouterAuthInput)` 即可。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/backend -- src/adapters/inbound/local-api/tests/account-routes.test.ts && npm run typecheck -w @memmy/backend`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add App/backend/src/adapters/inbound/local-api App/frontend/desktop/src/api/account-client.ts
git commit -m "feat(account): expose the line list and probe over the local API"
```

---

### Task 7: 注册卡片的线路单选

**Files:**
- Modify: `App/frontend/desktop/src/components/auth-credentials-form.tsx`
- Modify: `App/frontend/desktop/src/components/account-auth-panel.tsx`
- Modify: `App/frontend/desktop/src/components/tests/account-auth-panel.test.tsx`
- Modify: `App/frontend/desktop/src/i18n/messages.ts`

**Interfaces:**
- Consumes: Task 6 的 `probeNodes()`、`getNodes()`
- Produces: 表单新 props
  `nodes: string[]`、`selectedNodeId: string | null`、`probingLine: boolean`、`onNodeChange: (nodeId: string) => void`

- [ ] **Step 1: 写失败的组件测试**

```tsx
it("shows the probed line as a radio group and submits the picked one", async () => {
  const probeNodes = vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: "cn" }));
  const register = vi.fn(async () => authResult({ isNewUser: true }));
  renderPanel({
    registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
    probeNodes,
    register
  });

  await switchToRegister();
  await vi.waitFor(() => expect(radioByLabel("account.node.cn")).not.toBeNull());
  expect(radioByLabel("account.node.cn")!.checked).toBe(true);
  expect(radioByLabel("account.node.hk")!.checked).toBe(false);

  await act(async () => radioByLabel("account.node.hk")!.click());
  await setInput("account.usernamePlaceholder", "alice");
  await setInput("account.passwordPlaceholder", "Passw0rd1");
  await setInput("account.confirmPasswordPlaceholder", "Passw0rd1");
  await clickButton("account.register");

  await vi.waitFor(() => expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ username: "alice", nodeId: "hk" })
  ));
});

it("re-reads the registration requirements when the line changes", async () => {
  const requirements: string[] = [];
  renderPanel({
    registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
    getRegistrationRequirements: async (nodeId?: string) => {
      requirements.push(nodeId ?? "default");
      return { emailVerificationRequired: nodeId === "hk", turnstileRequired: false };
    }
  });

  await switchToRegister();
  await vi.waitFor(() => expect(radioByLabel("account.node.cn")).not.toBeNull());
  // cn needs no email; switching to hk must bring the email fields in without a submit.
  await act(async () => radioByLabel("account.node.hk")!.click());
  await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
  expect(requirements).toContain("hk");
});

it("defaults to Hong Kong and keeps both options pickable when nothing is reachable", async () => {
  renderPanel({
    registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
    probeNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: null }))
  });

  await switchToRegister();
  await vi.waitFor(() => expect(radioByLabel("account.node.hk")).not.toBeNull());
  expect(radioByLabel("account.node.hk")!.checked).toBe(true);
  expect(radioByLabel("account.node.cn")!.disabled).toBe(false);
});

it("hides the picker when there is only one line, and blocks submitting while probing", async () => {
  let releaseProbe: (value: { nodes: string[]; defaultNodeId: string | null }) => void = () => undefined;
  renderPanel({
    registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
    probeNodes: vi.fn(() => new Promise((resolve) => { releaseProbe = resolve; }))
  });

  await switchToRegister();
  expect(buttonByLabel("account.register")!.disabled).toBe(true);

  await act(async () => releaseProbe({ nodes: ["cn"], defaultNodeId: "cn" }));
  await vi.waitFor(() => expect(buttonByLabel("account.register")!.disabled).toBe(false));
  expect(radioByLabel("account.node.cn")).toBeNull();
});
```

辅助：`radioByLabel(label)` 在 `container.querySelectorAll('input[type="radio"]')` 里按相邻 label 文案匹配；`renderPanel` 的入参新增 `probeNodes`（默认 `async () => ({ nodes: ["cn", "hk"], defaultNodeId: "cn" })`）与 `getRegistrationRequirements`（默认沿用现有实现），并把它们注入假 `clients.account`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/frontend-desktop -- src/components/tests/account-auth-panel.test.tsx`
Expected: FAIL —— 找不到 radio

- [ ] **Step 3: 实现**

面板（`account-auth-panel.tsx`）：

```tsx
  // 线路是账号属性（两地账号独立），所以默认值来自后端探测，选择权交给用户。
  const [nodes, setNodes] = useState<string[]>([]);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [probingLine, setProbingLine] = useState(false);

  useEffect(() => {
    if (!clients?.account) return undefined;
    let cancelled = false;
    setProbingLine(true);
    void (async () => {
      try {
        const probe = await clients.account.probeNodes();
        if (cancelled) return;
        setNodes(probe.nodes);
        setNodeId(probe.defaultNodeId ?? probe.nodes[0] ?? null);
      } catch (error) {
        console.warn("cuberouter node probe failed", error);
        if (!cancelled) setNodes([]);
      } finally {
        if (!cancelled) setProbingLine(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clients]);

  // A different line can demand a different registration form (email verification,
  // Turnstile), so the requirements are re-read whenever the user switches.
  useEffect(() => { /* 见下：替换掉原来那个只在挂载时读一次的 effect */ }, [clients, nodeId, t]);
```

上面第二段是**替换**现有的注册要求 effect（原实现只在挂载时读一次）：

```tsx
  useEffect(() => {
    if (!clients?.account) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const requirements = await clients.account.getRegistrationRequirements(nodeId ?? undefined);
        if (cancelled) return;
        setEmailVerificationRequired(requirements.emailVerificationRequired);
        if (requirements.turnstileRequired) {
          setWarning(t("account.warning.turnstileRequired"));
        }
      } catch (error) {
        console.warn("registration requirements probe failed", error);
        if (!cancelled) setWarning(toFeedbackText(error, t));
      }
    })();
    return () => { cancelled = true; };
  }, [clients, nodeId, t]);
```

注册提交时带上 `...(nodeId ? { nodeId } : {})`；`submit()` 在 `probingLine` 为真时直接返回；表单 `disabled` 传 `auth.pending || continuing || probingLine`（探测未落地不能提交 —— 选完即定终身）；表单新增 `nodes`、`selectedNodeId`、`probingLine`、`onNodeChange`。

表单（`auth-credentials-form.tsx`，放在用户名输入框之前，仅注册模式且 `nodes.length > 1` 时渲染）：

```tsx
      {props.mode === "register" && (props.nodes?.length ?? 0) > 1 ? (
        <fieldset className="space-y-2 text-left">
          <legend className="text-xs text-text-ink/60">{t("account.line")}</legend>
          {props.nodes.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm text-text-ink/80">
              <input
                type="radio"
                name="cuberouter-line"
                value={id}
                checked={props.selectedNodeId === id}
                onChange={() => props.onNodeChange(id)}
                disabled={props.disabled}
              />
              {t(`account.node.${id}` as MessageKey)}
            </label>
          ))}
        </fieldset>
      ) : null}
```

i18n（中英各 3 条）：`account.line`（注册线路 / Line）、`account.node.cn`（大陆 / Mainland China）、`account.node.hk`（香港 / Hong Kong）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/frontend-desktop -- src/components/tests/account-auth-panel.test.tsx src/pages/tests/auth-flow.test.ts && npm run typecheck -w @memmy/frontend-desktop`
Expected: PASS（新 3 条 + 现有全部；`auth-flow.test.ts` 的假 client 需要补 `probeNodes`）

- [ ] **Step 5: 提交**

```bash
git add App/frontend/desktop/src/components App/frontend/desktop/src/i18n/messages.ts
git commit -m "feat(auth): pick the registration line with radio buttons"
```

---

### Task 8: 设置页显示当前线路

**Files:**
- Modify: `App/frontend/desktop/src/pages/settings-page.tsx`（账号区块）
- Modify: `App/frontend/desktop/src/pages/tests/settings-page.test.tsx`（若无则在本任务新建最小用例）

**Interfaces:**
- Consumes: Task 6 的 `getNodes()`
- Produces: 设置页一行只读文案「当前线路：大陆」

- [ ] **Step 1: 写失败的测试**

```tsx
it("shows the line the account is on, and nothing when unconfigured", async () => {
  mocks.clients = { account: { getNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], currentNodeId: "cn" })) } } as never;

  await act(async () => root.render(<SettingsPage />));

  await vi.waitFor(() => expect(container.textContent).toContain("account.line"));
  expect(container.textContent).toContain("account.node.cn");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -w @memmy/frontend-desktop -- src/pages/tests/settings-page.test.tsx`
Expected: FAIL —— 文案不存在

- [ ] **Step 3: 实现**

账号区块里读取一次并按需渲染（`currentNodeId` 为 null 或节点未配置时不渲染）：

```tsx
      {currentNodeId ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-ink/60">{t("account.line")}</span>
          <span className="text-text-ink/85">{t(`account.node.${currentNodeId}` as MessageKey)}</span>
        </div>
      ) : null}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -w @memmy/frontend-desktop && npm run typecheck -w @memmy/frontend-desktop`
Expected: 桌面全量 PASS

- [ ] **Step 5: 提交**

```bash
git add App/frontend/desktop/src/pages
git commit -m "feat(settings): show the current cuberouter line"
```

---

## 收尾

- [ ] 两端全量：`npm run test -w @memmy/backend && npm run test -w @memmy/frontend-desktop`
- [ ] 两端 typecheck：`npm run typecheck -w @memmy/backend && npm run typecheck -w @memmy/frontend-desktop`
- [ ] 更新 `docs/superpowers/plans/2026-09-18-cuberouter-followups.md`：F1 标为已实现，F2 记为"节点表注入 manifest 时一并处理"，并加一行测试记录
- [ ] 真机验证（Windows 打包版）：注册卡片出现单选、默认值与实测一致、注册后 `config.yaml` 的 `cuberouter.baseUrl` 指向所选节点、日志里有探测明细；退出登录再登录不重放引导（F8）
