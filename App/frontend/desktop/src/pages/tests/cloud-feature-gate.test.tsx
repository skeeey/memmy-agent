/** Cloud feature gate tests. */
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { HomePage } from "../home-page.js";
import { ToolsPage } from "../tools-page.js";

const mocks = vi.hoisted(() => ({
  state: null as AppState | null
}));

vi.mock("../../state/app-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/app-state.js")>();
  return { ...actual, useAppState: () => ({ state: mocks.state, dispatch: vi.fn() }) };
});

const toolsUnavailableText = "当前账号未连接 Memmy 云服务，工具连接不可用。";

beforeEach(() => {
  mocks.state = createInitialAppState();
});

describe("cloud feature gate", () => {
  it("hides the tools page from a cuberouter identity and keeps it for a memmy cloud one", () => {
    mocks.state = createStateWithIdentity("cuberouter");
    const cuberouterHtml = renderToolsPage();

    expect(cuberouterHtml).toContain(toolsUnavailableText);
    expect(cuberouterHtml).not.toContain("tools-icon-grid");

    mocks.state = createStateWithIdentity("memmy_cloud");
    const cloudHtml = renderToolsPage();

    expect(cloudHtml).toContain("tools-icon-grid");
    expect(cloudHtml).not.toContain(toolsUnavailableText);
  });

  it("hides the home page voice input from a cuberouter identity and keeps it for a memmy cloud one", () => {
    mocks.state = createStateWithIdentity("cuberouter");
    const cuberouterHtml = renderHomePage();

    expect(cuberouterHtml).toContain("分配一个任务或提问任何问题...");
    expect(cuberouterHtml).not.toContain("语音输入");
    expect(cuberouterHtml).not.toContain('data-icon="mic"');

    mocks.state = createStateWithIdentity("memmy_cloud");
    const cloudHtml = renderHomePage();

    expect(cloudHtml).toContain("语音输入");
    expect(cloudHtml).toContain('data-icon="mic"');
  });

  it("drops the product tour's tools step for a cuberouter identity so the tour can still be dismissed", () => {
    const routerSource = readFileSync(new URL("../../app/router.tsx", import.meta.url), "utf8");

    expect(routerSource).toContain("includeTools={canUseCloudFeatures(state)}");
  });
});

function createStateWithIdentity(identityProvider: "memmy_cloud" | "cuberouter"): AppState {
  return appReducer(createInitialAppState(), appActions.accountUpdated({ identityProvider }));
}

function renderToolsPage(): string {
  return renderToString(
    <AppProviders>
      <ToolsPage />
    </AppProviders>
  );
}

function renderHomePage(): string {
  return renderToString(
    <AppProviders>
      <AgentRuntimeBridge>
        <HomePage />
      </AgentRuntimeBridge>
    </AppProviders>
  );
}
