// @vitest-environment happy-dom

/** Welcome page cloud entry tests. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { WelcomePage } from "../welcome-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

const mocks = vi.hoisted(() => ({
  state: null as AppState | null,
  cuberouterAccountBackend: true
}));

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: null, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: mocks.state, dispatch: vi.fn() })
}));

vi.mock("../../i18n/use-translation.js", () => ({
  useTranslation: () => ({ t: (key: string) => key, language: "zh-CN" })
}));

vi.mock("../../analytics/use-analytics.js", () => ({
  useAnalytics: () => ({ track: vi.fn(), ready: true })
}));

// The sign-in card has its own tests; rendering it here would only need a full client stub.
vi.mock("../../components/account-auth-panel.js", () => ({
  AccountAuthPanel: () => <div data-testid="auth-panel" />
}));

vi.mock("../../app/account-backend.js", () => ({
  isCuberouterAccountBackend: () => mocks.cuberouterAccountBackend
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WelcomePage cloud entries", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    // The fixture advertises both the sign-up gift and a token total, so the banner is
    // otherwise eligible to render.
    mocks.state = { ...createInitialAppState(), bootstrap: mockBootstrap };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    mocks.state = null;
  });

  it("hides the sign-up gift and the registration bypass for a cuberouter build", async () => {
    render();

    // Without this the assertions below would also pass on a page that failed to render.
    expect(container.querySelector('[data-testid="auth-panel"]')).not.toBeNull();
    expect(text()).not.toContain("welcome.gift");
    expect(button("welcome.byok.quickAction")).toBeNull();
  });

  it("keeps both for a memmy cloud build", async () => {
    mocks.cuberouterAccountBackend = false;
    render();

    expect(text()).toContain("welcome.gift");
    expect(button("welcome.byok.quickAction")).not.toBeNull();
  });

  function render() {
    act(() => root.render(<WelcomePage />));
  }

  function text(): string {
    return container.textContent ?? "";
  }

  function button(label: string): HTMLButtonElement | null {
    return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label) ?? null;
  }
});
