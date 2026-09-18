/** Account auth panel module. */
import type { CuberouterAuthResult, OnboardingStateDto } from "@memmy/local-api-contracts";
import { useEffect, useState } from "react";
import { setAnalyticsUserId } from "../analytics/analytics-context.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { buildInvitationSignupEvent } from "../app/invitation-analytics.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildAccountOnboardingStartPatch, resolvePostLoginRoute } from "../app/routes.js";
import { useTranslation } from "../i18n/use-translation.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { provisionByokModel } from "../state/model-provisioning.js";
import { openExternalUrl } from "../utils/open-url.js";
import { AuthCredentialsForm } from "./auth-credentials-form.js";
import { toFeedbackText, useAccountAuth, useEmailVerificationCode } from "./use-account-auth.js";

/** Cuberouter-backed register/login panel shared by the welcome and login pages. */
export function AccountAuthPanel() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { track } = useAnalytics();
  const { t, language } = useTranslation();
  const auth = useAccountAuth();
  const code = useEmailVerificationCode();
  const [mode, setMode] = useState<"register" | "login">("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [emailVerificationRequired, setEmailVerificationRequired] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  // The instance decides the form's shape, so ask it instead of guessing: a mismatch here
  // is what produced "email verification is enabled" only after a doomed submit.
  useEffect(() => {
    if (!clients?.account) {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const requirements = await clients.account.getRegistrationRequirements();
        if (cancelled) {
          return;
        }
        setEmailVerificationRequired(requirements.emailVerificationRequired);
        if (requirements.turnstileRequired) {
          setWarning(t("account.warning.turnstileRequired"));
        }
      } catch (error) {
        // Unreachable, or an instance that does not answer: fall back to the plain form, but
        // say so. Silently showing the plain form is indistinguishable from an instance that
        // needs nothing, which turns a misconfigured server address into a mystery: the
        // fields are simply missing and nothing explains why.
        console.warn("registration requirements probe failed", error);
        setWarning(toFeedbackText(error, t));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, t]);
  // An authenticated result whose continuation failed; a retry must re-run only the
  // continuation, never the register/login call (re-registering would fail outright).
  const [pendingAuthResult, setPendingAuthResult] = useState<CuberouterAuthResult | null>(null);

  /** Drops a stored authentication result: new credentials must authenticate from scratch. */
  function clearPendingAuthResult() {
    setPendingAuthResult(null);
  }

  /** Requests a code and surfaces either outcome in the form's own feedback slot. */
  async function sendVerificationCode() {
    setWarning(null);
    auth.clearFeedback();
    const outcome = await code.send(email);
    if (!outcome.ok && outcome.text) {
      auth.setFailure({ text: outcome.text, tone: "error" });
    }
  }

  async function submit() {
    if (auth.pending || continuing) return;
    setWarning(null);
    if (pendingAuthResult) {
      await continueAfterAuth(pendingAuthResult);
      return;
    }
    const credentials = {
      username,
      password,
      // Only registration compares the confirmation; login has no such field on screen, and
      // the empty state string would otherwise fail the match check.
      confirmPassword: mode === "register" ? confirmPassword : undefined,
      email,
      verificationCode,
      emailVerificationRequired
    };
    const result = mode === "register"
      ? await auth.register(credentials)
      : await auth.login(credentials);
    if (!result || !result.session.authenticated) return;
    setAnalyticsUserId(result.session.profile.userId);
    // Emitted once per authentication, never on a continuation retry, and it describes this
    // flow: the method is the cuberouter identity and the mode the panel selects is BYOK.
    track(buildInvitationSignupEvent({
      channel: "cuberouter",
      isNewUser: result.session.isNewUser === true,
      userMode: "byok"
    }));
    await continueAfterAuth(result);
  }

  async function continueAfterAuth(result: CuberouterAuthResult) {
    const session = result.session;
    if (!session.authenticated) return;

    dispatch(appActions.accountUpdated({
      userId: session.profile.userId,
      email: session.profile.email ?? "",
      phoneNumber: session.profile.phoneNumber,
      nickname: session.profile.nickname,
      registeredAt: session.profile.registeredAt,
      identityProvider: session.profile.identityProvider
    }));

    if (!clients?.config) {
      auth.setFailure({ text: t("account.error.provisionFailed"), tone: "error" });
      return;
    }

    try {
      setContinuing(true);
      const saved = await provisionByokModel({
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
      dispatch(appActions.modelConfigUpdated(saved));

      // The self-check needs its own guard: it either returns { ok: false } (no quota yet, or
      // the model is missing from the target instance's capability table) or throws outright
      // (the probe request itself failed). Neither may block: the account and the model config
      // are already written, so bailing out here would strand the user on the auth page.
      try {
        const test = await clients.config.testModelConfig(saved, "chat");
        if (!test.ok) {
          setWarning(t("account.warning.modelUnavailable", { reason: test.message }));
        }
      } catch (error) {
        console.warn("model connection self-check failed", error);
        setWarning(t("account.warning.modelUnavailable", { reason: t("account.error.requestFailed") }));
      }
    } catch (error) {
      console.error("provision model config failed", error);
      auth.setFailure({ text: t("account.error.provisionFailed"), tone: "error" });
      return;
    } finally {
      setContinuing(false);
    }

    // `profile.hasFinishedGuide` is always null for a cuberouter identity, so the returning
    // user has to be recognised from `isNewUser` (the repository computes it from whether an
    // account row already existed) plus the onboarding state already persisted locally.
    // Only a brand-new identity may start onboarding: persisting the start patch for a
    // returning user resets onboarding for good, because the reset survives restarts.
    const onboardingPatch: Partial<OnboardingStateDto> = session.isNewUser === true
      ? buildAccountOnboardingStartPatch(state.bootstrap?.onboarding)
      : {};
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
      setPendingAuthResult(null);
      // The self-test warning never changes routing: a new user runs onboarding, a returning
      // user follows the onboarding state already persisted on this machine.
      dispatch(appActions.navigate(
        resolvePostLoginRoute({ onboarding: nextOnboarding, preferredMode: state.navigation.preferredMode })
      ));
    } catch (error) {
      console.error("persist byok mode failed", error);
      setPendingAuthResult(result);
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
        emailVerificationRequired={emailVerificationRequired}
        email={email}
        verificationCode={verificationCode}
        sendingCode={code.sending}
        codeSecondsLeft={code.secondsLeft}
        disabled={auth.pending || continuing}
        feedback={auth.feedback ?? (warning ? { text: warning, tone: "error" } : null)}
        onUsernameChange={(next) => { clearPendingAuthResult(); setUsername(next); }}
        onPasswordChange={(next) => { clearPendingAuthResult(); setPassword(next); }}
        onConfirmPasswordChange={(next) => { clearPendingAuthResult(); setConfirmPassword(next); }}
        onEmailChange={(next) => { clearPendingAuthResult(); setEmail(next); }}
        onVerificationCodeChange={(next) => { clearPendingAuthResult(); setVerificationCode(next); }}
        onSendCode={() => void sendVerificationCode()}
        onModeChange={(next) => { auth.clearFeedback(); clearPendingAuthResult(); setMode(next); }}
        onSubmit={() => void submit()}
        onOpenTerms={() => void openExternalUrl(getLegalLinkUrl("terms", language, state.bootstrap?.legal))}
        onOpenDataAgreement={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}
      />
    </div>
  );
}
