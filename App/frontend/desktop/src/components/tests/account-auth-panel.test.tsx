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
import { writeGuidanceCompleted } from "../../app/routes.js";
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
    // The guidance marker lives in localStorage; one test sets it, and it must not leak.
    window.localStorage.clear();
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

  it("routes on the onboarding state read back after login, not the pre-login snapshot", async () => {
    // A launch can read the onboarding in a different scope than the one the completion was
    // written to, so the snapshot taken before login may say "not completed" about an account
    // that is. The value written and read back during login is the authoritative one.
    mocks.state = createStaleOnboardingState();
    const updateOnboarding = vi.fn(async (onboarding: unknown) => ({
      ...(onboarding as object),
      completed: true,
      currentStep: "completed",
      completedAt: "2026-09-20T07:38:27.621Z"
    }));
    mocks.clients = {
      account: {
        getRegistrationRequirements: vi.fn(async () => ({ emailVerificationRequired: false, turnstileRequired: false })),
        login: vi.fn(async () => authResult({ isNewUser: false }))
      },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog: vi.fn(async () => emptyProviderConfig()),
        testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-09-16T00:00:00.000Z" })),
        updateSettings: vi.fn(async (settings: unknown) => settings),
        updateOnboarding
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
    await fillInput(0, "alice");
    await fillInput(1, "Passw0rd1");
    await clickButton("account.login");

    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/main")));
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/onboarding"));
  });

  it("does not send a machine that already ran the guidance back into onboarding", async () => {
    // The stored row can change scope or identity across a logout; the machine-level marker
    // cannot, and the guidance is documented to run once per machine.
    writeGuidanceCompleted(window.localStorage);
    mocks.state = createStaleOnboardingState();
    mocks.clients = {
      account: {
        getRegistrationRequirements: vi.fn(async () => ({ emailVerificationRequired: false, turnstileRequired: false })),
        login: vi.fn(async () => authResult({ isNewUser: false }))
      },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog: vi.fn(async () => emptyProviderConfig()),
        testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-09-16T00:00:00.000Z" })),
        updateSettings: vi.fn(async (settings: unknown) => settings),
        // The row still reports unfinished, which is exactly the case that replayed.
        updateOnboarding: vi.fn(async (onboarding: unknown) => ({
          ...(onboarding as object),
          completed: false,
          currentStep: "scan_permission_required"
        }))
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
    await fillInput(0, "alice");
    await fillInput(1, "Passw0rd1");
    await clickButton("account.login");

    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/main")));
    expect(mocks.dispatch).not.toHaveBeenCalledWith(appActions.navigate("/onboarding"));
  });

  it("keeps a returning user's completed onboarding and routes to /main", async () => {
    mocks.state = createCompletedOnboardingState();
    const updateOnboarding = vi.fn(async (onboarding: unknown) => onboarding);
    mocks.clients = {
      account: {
        getRegistrationRequirements: vi.fn(async () => ({ emailVerificationRequired: false, turnstileRequired: false })),
        login: vi.fn(async () => authResult({ isNewUser: false }))
      },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog: vi.fn(async () => emptyProviderConfig()),
        testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-09-16T00:00:00.000Z" })),
        updateSettings: vi.fn(async (settings: unknown) => settings),
        updateOnboarding
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
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
      account: {
        getRegistrationRequirements: vi.fn(async () => ({ emailVerificationRequired: false, turnstileRequired: false })),
        register: vi.fn(async () => authResult({ isNewUser: true }))
      },
      config: {
        getModelConfig: vi.fn(async () => emptyProviderConfig()),
        saveModelCatalog: vi.fn(async () => emptyProviderConfig()),
        testModelConfig: vi.fn(async () => ({ ok: true, message: "ok", checkedAt: "2026-09-16T00:00:00.000Z" })),
        updateSettings: vi.fn(async (settings: unknown) => settings),
        updateOnboarding: vi.fn(async (onboarding: unknown) => onboarding)
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
    await switchToRegister();
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
      account: {
        getRegistrationRequirements: vi.fn(async () => ({ emailVerificationRequired: false, turnstileRequired: false })),
        register: vi.fn(async () => authResult())
      },
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
    await switchToRegister();
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

  it("opens on the login form with the register link below it", async () => {
    renderPanel({ registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false } });

    expect(buttonByLabel("account.login")).not.toBeNull();
    expect(buttonByLabel("account.register")).toBeNull();
    expect(buttonByLabel("account.switchToRegister")).not.toBeNull();
    // The register-only fields stay out of the first screen.
    expect(inputByPlaceholder("account.confirmPasswordPlaceholder")).toBeNull();
    // The toggle reaches the register form, which then offers the way back.
    await switchToRegister();
    expect(buttonByLabel("account.register")).not.toBeNull();
    expect(buttonByLabel("account.switchToLogin")).not.toBeNull();
  });

  it("adds the email inputs when the instance requires email verification", async () => {
    renderPanel({ registrationRequirements: { emailVerificationRequired: true, turnstileRequired: false } });

    await switchToRegister();
    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    expect(inputByPlaceholder("account.verificationCodePlaceholder")).not.toBeNull();
    expect(buttonByLabel("account.sendCode")).not.toBeNull();
  });

  it("leaves the form untouched when the instance does not verify email", async () => {
    renderPanel({ registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false } });

    await switchToRegister();
    // The probe resolves asynchronously; give it the chance to (wrongly) add fields.
    await act(async () => await Promise.resolve());
    expect(inputByPlaceholder("account.emailPlaceholder")).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(3);
  });

  it("keeps the plain form but says so when the instance cannot be reached", async () => {
    // The fallback alone is indistinguishable from "this instance needs nothing", so a
    // misconfigured server address used to look like a form that simply has no extra
    // fields and no explanation.
    const message = "无法连接 cuberouter 服务，请检查服务地址与网络";
    renderPanel({ requirementsError: new ApiRequestError(message, 503, "cuberouter_unavailable") });

    await switchToRegister();
    await vi.waitFor(() => expect(alertText()).toBe(message));
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

    await switchToRegister();
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

    await switchToRegister();
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

    await switchToRegister();
    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    await setInput("account.emailPlaceholder", "alice@example.com");
    await clickButton("account.sendCode");

    await vi.waitFor(() => expect(alertText()).toBe(message));
  });

  it("warns instead of silently failing when the instance demands Turnstile", async () => {
    renderPanel({ registrationRequirements: { emailVerificationRequired: true, turnstileRequired: true } });

    await vi.waitFor(() => expect(alertText()).toBe("account.warning.turnstileRequired"));
  });

  it("shows the probed line as radio buttons and submits the picked one", async () => {
    const register = vi.fn(async () => authResult({ isNewUser: true }));
    renderPanel({
      registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
      probeNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: "cn" })),
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
    const asked: Array<string | undefined> = [];
    renderPanel({
      registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
      probeNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: "cn" })),
      getRegistrationRequirements: async (nodeId?: string) => {
        asked.push(nodeId);
        return { emailVerificationRequired: nodeId === "hk", turnstileRequired: false };
      }
    });

    await switchToRegister();
    await vi.waitFor(() => expect(radioByLabel("account.node.cn")).not.toBeNull());
    expect(inputByPlaceholder("account.emailPlaceholder")).toBeNull();

    // The mainland line asks for nothing extra; switching to Hong Kong must bring the email
    // fields in without a doomed submit.
    await act(async () => radioByLabel("account.node.hk")!.click());
    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    expect(asked).toContain("hk");
  });

  it("renders the preselected line and keeps both pickable when the probe reached nothing", async () => {
    // The backend applies the "nothing reachable → the build's default line" rule; the card
    // only has to render what it is told and leave the other line selectable.
    renderPanel({
      registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
      probeNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: "hk" }))
    });

    await switchToRegister();
    await vi.waitFor(() => expect(radioByLabel("account.node.hk")).not.toBeNull());
    expect(radioByLabel("account.node.hk")!.checked).toBe(true);
    expect(radioByLabel("account.node.cn")!.disabled).toBe(false);
  });

  it("hides the picker for a single line and blocks submitting while probing", async () => {
    let releaseProbe: (value: { nodes: string[]; defaultNodeId: string | null }) => void = () => undefined;
    renderPanel({
      registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
      probeNodes: vi.fn(() => new Promise((resolve) => { releaseProbe = resolve; }))
    });

    await switchToRegister();
    // The button says why it cannot be used yet rather than looking broken.
    expect(buttonByLabel("account.probingLine")!.disabled).toBe(true);
    expect(buttonByLabel("account.register")).toBeNull();

    await act(async () => releaseProbe({ nodes: ["cn"], defaultNodeId: "cn" }));
    await vi.waitFor(() => expect(buttonByLabel("account.register")!.disabled).toBe(false));
    expect(radioByLabel("account.node.cn")).toBeNull();
  });

  it("never preselects a line the picker does not offer", async () => {
    renderPanel({
      registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
      probeNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: "mars" }))
    });

    await switchToRegister();
    await vi.waitFor(() => expect(radioByLabel("account.node.cn")).not.toBeNull());
    expect(radioByLabel("account.node.cn")!.checked).toBe(true);
    expect(radioByLabel("account.node.hk")!.checked).toBe(false);
  });

  it("drops a warning that belonged to the line the user just left", async () => {
    renderPanel({
      registrationRequirements: { emailVerificationRequired: false, turnstileRequired: false },
      probeNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: "hk" })),
      getRegistrationRequirements: async (nodeId?: string) => ({
        emailVerificationRequired: false,
        turnstileRequired: nodeId === "hk"
      })
    });

    await switchToRegister();
    await vi.waitFor(() => expect(alertText()).toBe("account.warning.turnstileRequired"));

    // cn needs nothing, so the hk verdict must not stay on screen and claim registration is impossible.
    await act(async () => radioByLabel("account.node.cn")!.click());
    await vi.waitFor(() => expect(alertText()).toBeNull());
  });

  it("asks the line the user picked for the verification code", async () => {
    // The code is instance-local, so a code requested from the current line would be rejected
    // by the line the account is actually being created on.
    const sendEmailVerificationCode = vi.fn(async () => ({ ok: true }));
    renderPanel({
      registrationRequirements: { emailVerificationRequired: true, turnstileRequired: false },
      probeNodes: vi.fn(async () => ({ nodes: ["cn", "hk"], defaultNodeId: "cn" })),
      sendEmailVerificationCode
    });

    await switchToRegister();
    await vi.waitFor(() => expect(radioByLabel("account.node.cn")).not.toBeNull());
    await act(async () => radioByLabel("account.node.hk")!.click());
    await setInput("account.emailPlaceholder", "alice@example.com");
    await clickButton("account.sendCode");

    await vi.waitFor(() => expect(sendEmailVerificationCode).toHaveBeenCalledWith(
      expect.objectContaining({ email: "alice@example.com", nodeId: "hk" })
    ));
  });

  it("logs in without email fields even when the instance verifies email at registration", async () => {
    // The requirement describes registration only: in login mode the email inputs are not
    // on screen, so enforcing them there would reject every login with a demand for an
    // address the user was never shown a field for.
    const login = vi.fn(async () => authResult({ isNewUser: false }));
    renderPanel({
      registrationRequirements: { emailVerificationRequired: true, turnstileRequired: false },
      login
    });

    // Wait for the probe through the register form: the email input appearing is what proves
    // the instance's answer landed, so the login assertions below are not just "not yet known".
    await switchToRegister();
    await vi.waitFor(() => expect(inputByPlaceholder("account.emailPlaceholder")).not.toBeNull());
    await clickButton("account.switchToLogin");
    expect(inputByPlaceholder("account.emailPlaceholder")).toBeNull();
    await setInput("account.usernamePlaceholder", "alice");
    await setInput("account.passwordPlaceholder", "Passw0rd1");
    await clickButton("account.login");

    // An exact-match assertion: no email or verificationCode may ride along.
    await vi.waitFor(() => expect(login).toHaveBeenCalledWith({ username: "alice", password: "Passw0rd1" }));
  });

  /** Moves the card from its login default to the register form. */
  async function switchToRegister() {
    await clickButton("account.switchToRegister");
  }

  /** Renders the panel against a fake account client carrying the given probe outcome. */
  function renderPanel(input: {
    registrationRequirements?: { emailVerificationRequired: boolean; turnstileRequired: boolean };
    requirementsError?: unknown;
    register?: (credentials: unknown) => Promise<unknown>;
    login?: (credentials: unknown) => Promise<unknown>;
    sendEmailVerificationCode?: (payload: unknown) => Promise<unknown>;
    probeNodes?: () => Promise<{ nodes: string[]; defaultNodeId: string | null }>;
    getRegistrationRequirements?: (nodeId?: string) => Promise<{
      emailVerificationRequired: boolean;
      turnstileRequired: boolean;
    }>;
  }) {
    mocks.clients = {
      account: {
        probeNodes: input.probeNodes ?? vi.fn(async () => ({ nodes: [], defaultNodeId: null })),
        getRegistrationRequirements: vi.fn(async (nodeId?: string) => {
          if (input.getRegistrationRequirements) {
            return await input.getRegistrationRequirements(nodeId);
          }
          if (input.requirementsError) {
            throw input.requirementsError;
          }
          return input.registrationRequirements ?? { emailVerificationRequired: false, turnstileRequired: false };
        }),
        register: input.register ?? vi.fn(async () => authResult({ isNewUser: true })),
        login: input.login ?? vi.fn(async () => authResult({ isNewUser: false })),
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

  /** Finds the radio whose label text is the given key (the i18n mock returns raw keys). */
  function radioByLabel(label: string): HTMLInputElement | null {
    return [...container.querySelectorAll('input[type="radio"]')].find(
      (candidate) => candidate.closest("label")?.textContent?.trim() === label
    ) as HTMLInputElement | null ?? null;
  }

  async function submitFailingLogin(error: unknown) {
    mocks.clients = {
      account: {
        getRegistrationRequirements: vi.fn(async () => ({ emailVerificationRequired: false, turnstileRequired: false })),
        login: vi.fn(async () => {
          throw error;
        })
      }
    } as unknown as AppClients;

    await act(async () => root.render(<AccountAuthPanel />));
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

/** The snapshot a launch reads when its onboarding scope differs from the one the completion landed in. */
function createStaleOnboardingState(): AppState {
  const bootstrap = {
    ...mockBootstrap,
    app: { ...mockBootstrap.app, userMode: "byok" as const },
    onboarding: {
      ...mockBootstrap.onboarding,
      completed: false,
      currentStep: "scan_permission_required" as const,
      completedAt: null
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
