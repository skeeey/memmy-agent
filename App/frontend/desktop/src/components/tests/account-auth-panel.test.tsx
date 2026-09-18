// @vitest-environment happy-dom

/** Account auth panel tests. */
import type { CuberouterAuthResult } from "@memmy/local-api-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import type { ModelProviderConfig } from "../../api/config-client.js";
import { ApiRequestError } from "../../api/http.js";
import { mockBootstrap } from "../../pages/tests/fixtures/bootstrap.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { createModelWorkspace } from "../../state/model-workspace.js";
import { AccountAuthPanel } from "../account-auth-panel.js";

const mocks = vi.hoisted(() => ({
  clients: null as AppClients | null,
  state: null as AppState | null,
  dispatch: vi.fn(),
  track: vi.fn()
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

vi.mock("../../analytics/use-analytics.js", () => ({
  useAnalytics: () => ({ track: mocks.track, ready: true })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AccountAuthPanel auth error copy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

  it("shows the transport message the spec promises when cuberouter is unreachable", async () => {
    const message = "无法连接 cuberouter 服务，请检查服务地址与网络";
    await submitFailingLogin(new ApiRequestError(message, 503, "cuberouter_unavailable"));

    expect(alertText()).toBe(message);
  });

  it("keeps a returning user's completed onboarding and routes to /main", async () => {
    mocks.state = createCompletedOnboardingState();
    const updateOnboarding = vi.fn(async (onboarding: unknown) => onboarding);
    mocks.clients = {
      account: { login: vi.fn(async () => authResult({ isNewUser: false })) },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog: vi.fn(async () => emptyProviderConfig()),
        testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-09-16T00:00:00.000Z" })),
        updateSettings: vi.fn(async (settings: unknown) => settings),
        updateOnboarding
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
    await clickButton("account.switchToLogin");
    await fillInput(0, "alice");
    await fillInput(1, "Passw0rd1");
    await clickButton("account.login");

    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/main")));
    // The persisted patch must not carry the new-user onboarding reset: doing so would
    // survive restarts and send the returning user through onboarding again.
    expect(updateOnboarding).toHaveBeenCalledWith({});
  });

  it("reports a cuberouter signup with the identity and the mode the panel selects", async () => {
    mocks.clients = {
      account: { register: vi.fn(async () => authResult({ isNewUser: true })) },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog: vi.fn(async () => emptyProviderConfig()),
        testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-09-16T00:00:00.000Z" })),
        updateSettings: vi.fn(async (settings: unknown) => settings),
        updateOnboarding: vi.fn(async (onboarding: unknown) => onboarding)
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
    await fillInput(0, "alice");
    await fillInput(1, "Passw0rd1");
    await fillInput(2, "Passw0rd1");
    await clickButton("account.register");

    await vi.waitFor(() => expect(mocks.track).toHaveBeenCalledWith({
      name: "signup_completed",
      params: {
        method: "cuberouter",
        is_new_user: true,
        user_mode: "byok",
        invite_code_provided: false
      },
      consentTier: "basic"
    }));
  });

  it("keeps the registered user moving when the model self-check itself throws", async () => {
    const updateSettings = vi.fn(async (settings) => settings);
    const saveModelCatalog = vi.fn(async () => emptyProviderConfig());
    mocks.clients = {
      account: { register: vi.fn(async () => authResult()) },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog,
        testModelConfig: vi.fn(async () => {
          throw new Error("Failed to fetch");
        }),
        updateSettings,
        updateOnboarding: vi.fn(async (onboarding) => onboarding)
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
    await fillInput(0, "alice");
    await fillInput(1, "Passw0rd1");
    await fillInput(2, "Passw0rd1");
    await clickButton("account.register");

    await vi.waitFor(() => expect(alertText()).toBe("account.warning.modelUnavailable"));
    // The account and the catalog write both succeeded, so the self-check must not strand the user.
    expect(saveModelCatalog).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ userMode: "byok" });
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/onboarding"));
  });

  it("adds the email inputs when the instance requires email verification", async () => {
    renderPanel({ registrationRequirements: { emailVerificationRequired: true, turnstileRequired: false } });

    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    expect(inputByPlaceholder("account.verificationCodePlaceholder")).not.toBeNull();
    expect(buttonByLabel("account.sendCode")).not.toBeNull();
  });

  it("leaves the form untouched when the instance does not verify email", async () => {
    renderPanel({ registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false } });

    // The probe resolves asynchronously; give it the chance to (wrongly) add fields.
    await act(async () => await Promise.resolve());
    expect(inputByPlaceholder("account.emailPlaceholder")).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(3);
  });

  it("keeps the plain form when the instance cannot be reached", async () => {
    renderPanel({ requirementsError: new ApiRequestError("无法连接 cuberouter 服务，请检查服务地址与网络", 503, "cuberouter_unavailable") });

    await act(async () => await Promise.resolve());
    expect(inputByPlaceholder("account.emailPlaceholder")).toBeNull();
  });

  it("submits the email and code the instance asked for", async () => {
    const register = vi.fn(async () => {
      throw new ApiRequestError("验证码错误或已过期", 400, "invalid_argument");
    });
    renderPanel({
      registrationRequirements: { emailVerificationRequired: true, turnstileRequired: false },
      register
    });

    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    await setInput("account.usernamePlaceholder", "alice");
    await setInput("account.emailPlaceholder", "alice@example.com");
    await setInput("account.passwordPlaceholder", "Passw0rd1");
    await setInput("account.confirmPasswordPlaceholder", "Passw0rd1");
    await setInput("account.verificationCodePlaceholder", "123456");
    await clickButton("account.register");

    await vi.waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        username: "alice",
        password: "Passw0rd1",
        email: "alice@example.com",
        verificationCode: "123456"
      })
    );
    expect(alertText()).toBe("验证码错误或已过期");
  });

  it("sends a code to the typed address and starts the cooldown", async () => {
    const sendEmailVerificationCode = vi.fn(async () => ({ ok: true }));
    renderPanel({
      registrationRequirements: { emailVerificationRequired: true, turnstileRequired: false },
      sendEmailVerificationCode
    });

    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    await setInput("account.emailPlaceholder", "alice@example.com");
    await clickButton("account.sendCode");

    await vi.waitFor(() => expect(sendEmailVerificationCode).toHaveBeenCalledWith({ email: "alice@example.com" }));
    // The label switching to the countdown is what proves the cooldown started.
    await vi.waitFor(() => expect(buttonByLabel("account.resendCode")).not.toBeNull());
  });

  it("shows the instance's own message when the code send is throttled", async () => {
    const message = "发送过于频繁，请等待 28 秒后再试";
    renderPanel({
      registrationRequirements: { emailVerificationRequired: true, turnstileRequired: false },
      sendEmailVerificationCode: vi.fn(async () => {
        throw new ApiRequestError(message, 429, "rate_limited");
      })
    });

    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    await setInput("account.emailPlaceholder", "alice@example.com");
    await clickButton("account.sendCode");

    await vi.waitFor(() => expect(alertText()).toBe(message));
  });

  it("warns instead of silently failing when the instance demands Turnstile", async () => {
    renderPanel({ registrationRequirements: { emailVerificationRequired: true, turnstileRequired: true } });

    await vi.waitFor(() => expect(alertText()).toBe("account.warning.turnstileRequired"));
  });

  /** Renders the panel against a fake account client carrying the given probe outcome. */
  function renderPanel(input: {
    registrationRequirements?: { emailVerificationRequired: boolean; turnstileRequired: boolean };
    requirementsError?: unknown;
    register?: (credentials: unknown) => Promise<unknown>;
    sendEmailVerificationCode?: (payload: unknown) => Promise<unknown>;
  }) {
    mocks.clients = {
      account: {
        getRegistrationRequirements: vi.fn(async () => {
          if (input.requirementsError) {
            throw input.requirementsError;
          }
          return input.registrationRequirements ?? { emailVerificationRequired: false, turnstileRequired: false };
        }),
        register: input.register ?? vi.fn(async () => authResult({ isNewUser: true })),
        login: vi.fn(async () => authResult({ isNewUser: false })),
        sendEmailVerificationCode: input.sendEmailVerificationCode ?? vi.fn(async () => ({ ok: true }))
      },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog: vi.fn(async () => emptyProviderConfig()),
        testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-09-16T00:00:00.000Z" })),
        updateSettings: vi.fn(async (settings: unknown) => settings),
        updateOnboarding: vi.fn(async (onboarding: unknown) => onboarding)
      }
    } as unknown as AppClients;

    act(() => root.render(<AccountAuthPanel />));
  }

  function inputByPlaceholder(placeholder: string): HTMLInputElement | null {
    return container.querySelector(`input[placeholder="${placeholder}"]`);
  }

  async function setInput(placeholder: string, value: string) {
    const input = inputByPlaceholder(placeholder);
    if (!input) {
      throw new Error(`input not found: ${placeholder}`);
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function buttonByLabel(label: string): HTMLButtonElement | null {
    return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label) ?? null;
  }

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

function emptyProviderConfig(): ModelProviderConfig {
  const catalog = createModelWorkspace(null).catalog;
  return {
    catalog,
    configRevision: catalog.configRevision,
    provider: "openai",
    endpoint: "",
    model: "",
    apiKey: "",
    apiKeyMasked: "",
    configured: false
  };
}

/**
 * Builds a local state where onboarding was already completed on this machine.
 *
 * @returns An app state with a completed local onboarding.
 */
function createCompletedOnboardingState(): AppState {
  const bootstrap = {
    ...mockBootstrap,
    app: { ...mockBootstrap.app, userMode: "byok" as const },
    onboarding: {
      ...mockBootstrap.onboarding,
      completed: true,
      currentStep: "completed" as const,
      completedAt: "2026-09-01T00:00:00.000Z"
    }
  };
  return appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/welcome"));
}

function authResult(overrides: { isNewUser?: boolean } = {}): CuberouterAuthResult {
  return {
    session: {
      authenticated: true,
      // The repository computes this from whether an account row already existed.
      isNewUser: overrides.isNewUser ?? true,
      profile: {
        userId: "cuberouter-user-1",
        email: "alice@example.com",
        phoneNumber: null,
        nickname: "alice",
        registeredAt: "2026-09-16T00:00:00.000Z",
        hasFinishedGuide: null
      }
    },
    provisioning: {
      apiKey: "sk-cuberouter",
      apiBase: "http://127.0.0.1:3100/v1",
      model: "deepseek-flash"
    }
  } as unknown as CuberouterAuthResult;
}
