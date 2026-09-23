// @vitest-environment happy-dom

/** Settings page line display tests. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountClient } from "../../api/account-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { SettingsPageView } from "../settings-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsPage registration line", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage()
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows the line the account is on", async () => {
    render({ getNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], currentNodeId: "cn" })) });

    await vi.waitFor(() => expect(container.textContent).toContain("当前线路"));
    expect(container.textContent).toContain("大陆");
  });

  it("shows nothing when no line is configured", async () => {
    render({ getNodes: vi.fn(async () => ({ nodes: [], currentNodeId: null })) });

    await act(async () => await Promise.resolve());
    expect(container.textContent).not.toContain("当前线路");
  });

  function render(accountClient: Partial<AccountClient>) {
    const state = appReducer(
      createInitialAppState(),
      appActions.bootstrapLoaded(
        { ...mockBootstrap, app: { ...mockBootstrap.app, userMode: "byok" as const, language: "zh-CN" as const } },
        "/settings"
      )
    );
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={state}
            dispatch={vi.fn()}
            platform="win32"
            accountClient={accountClient as AccountClient}
            update={{
              appVersion: "2.1.0",
              phase: "idle",
              preparedUpdatePath: null,
              downloadProgress: null,
              feedback: null,
              requestInlineAction: vi.fn(async () => undefined),
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
    });
  }
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
  };
}
