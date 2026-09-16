// @vitest-environment happy-dom

/** Account auth panel tests. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { ApiRequestError } from "../../api/http.js";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { AccountAuthPanel } from "../account-auth-panel.js";

const mocks = vi.hoisted(() => ({
  clients: null as AppClients | null,
  state: null as AppState | null,
  dispatch: vi.fn()
}));

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: mocks.clients, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch })
}));

vi.mock("../../i18n/use-translation.js", () => ({
  useTranslation: () => ({ t: (key: string) => key, language: "zh-CN" })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AccountAuthPanel auth error copy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.state = createInitialAppState();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    mocks.clients = null;
    mocks.state = null;
    vi.restoreAllMocks();
  });

  it("shows the server business message for a rejected login", async () => {
    await submitFailingLogin(new ApiRequestError("用户名或密码不正确", 400, "invalid_argument"));

    expect(alertText()).toBe("用户名或密码不正确");
  });

  it("falls back to translated copy for an internal envelope", async () => {
    await submitFailingLogin(new ApiRequestError("boom", 500, "internal"));

    expect(alertText()).toBe("account.error.requestFailed");
  });

  it("falls back to translated copy for a transport failure", async () => {
    await submitFailingLogin(new Error("Failed to fetch"));

    expect(alertText()).toBe("account.error.requestFailed");
  });

  it("falls back to translated copy when the server sends an empty message", async () => {
    await submitFailingLogin(new ApiRequestError("", 400, "invalid_argument"));

    expect(alertText()).toBe("account.error.requestFailed");
  });

  async function submitFailingLogin(error: unknown) {
    mocks.clients = {
      account: {
        login: vi.fn(async () => {
          throw error;
        })
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
    await clickButton("account.switchToLogin");
    await fillInput(0, "alice");
    await fillInput(1, "Passw0rd1");
    await clickButton("account.login");
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  }

  function alertText(): string | null {
    return container.querySelector('[role="alert"]')?.textContent ?? null;
  }

  async function fillInput(index: number, value: string) {
    const input = [...container.querySelectorAll("input")][index];
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`input not found: ${index}`);
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function clickButton(label: string) {
    const target = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
    if (!(target instanceof HTMLButtonElement)) {
      throw new Error(`button not found: ${label}`);
    }
    await act(async () => target.click());
  }
});
