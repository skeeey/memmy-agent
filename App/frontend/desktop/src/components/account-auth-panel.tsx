/** Account auth panel module. */
import type { CuberouterAuthResult, OnboardingStateDto } from "@memmy/local-api-contracts";
import { useState } from "react";
import { setAnalyticsUserId } from "../analytics/analytics-context.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildAccountOnboardingStartPatch, resolvePostLoginRoute, shouldShowFirstEncounterReport } from "../app/routes.js";
import { useTranslation } from "../i18n/use-translation.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { provisionByokModel } from "../state/model-provisioning.js";
import { openExternalUrl } from "../utils/open-url.js";
import { AuthCredentialsForm } from "./auth-credentials-form.js";
import { useAccountAuth } from "./use-account-auth.js";

/** Cuberouter-backed register/login panel shared by the welcome and login pages. */
export function AccountAuthPanel() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t, language } = useTranslation();
  const auth = useAccountAuth();
  const [mode, setMode] = useState<"register" | "login">("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  async function submit() {
    if (auth.pending || continuing) return;
    setWarning(null);
    const result = mode === "register"
      ? await auth.register(username, password, confirmPassword)
      : await auth.login(username, password);
    if (!result) return;
    await continueAfterAuth(result);
  }

  async function continueAfterAuth(result: CuberouterAuthResult) {
    const session = result.session;
    if (!session.authenticated) return;

    setAnalyticsUserId(session.profile.userId);
    dispatch(appActions.accountUpdated({
      userId: session.profile.userId,
      email: session.profile.email ?? "",
      phoneNumber: session.profile.phoneNumber,
      nickname: session.profile.nickname,
      registeredAt: session.profile.registeredAt
    }));

    if (!clients?.config) {
      auth.setFailure({ text: t("account.error.provisionFailed"), tone: "error" });
      return;
    }

    try {
      setContinuing(true);
      await provisionByokModel({
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
      const saved = await clients.config.getModelConfig();
      dispatch(appActions.modelConfigUpdated(saved));

      // A failed self-test must not block: a new account may have no quota yet, or
      // the model may be missing from the target instance's capability table.
      const test = await clients.config.testModelConfig(saved, "chat");
      if (!test.ok) {
        setWarning(t("account.warning.modelUnavailable", { reason: test.message }));
      }
    } catch (error) {
      console.error("provision model config failed", error);
      auth.setFailure({ text: t("account.error.provisionFailed"), tone: "error" });
      return;
    } finally {
      setContinuing(false);
    }

    const onboardingPatch: Partial<OnboardingStateDto> =
      session.profile.hasFinishedGuide && state.bootstrap && !shouldShowFirstEncounterReport(state.bootstrap.onboarding)
      ? { completed: true, currentStep: "completed", completedAt: new Date().toISOString(), hasAcceptedTerms: true }
      : buildAccountOnboardingStartPatch(state.bootstrap?.onboarding);
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
      // The self-test warning never changes routing: new users run onboarding, returning users follow their guide state.
      dispatch(appActions.navigate(
        resolvePostLoginRoute({ onboarding: nextOnboarding, preferredMode: state.navigation.preferredMode })
      ));
    } catch (error) {
      console.error("persist byok mode failed", error);
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
        disabled={auth.pending || continuing}
        feedback={warning ? { text: warning, tone: "error" } : auth.feedback}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onConfirmPasswordChange={setConfirmPassword}
        onModeChange={(next) => { auth.clearFeedback(); setMode(next); }}
        onSubmit={() => void submit()}
        onOpenTerms={() => void openExternalUrl(getLegalLinkUrl("terms", language, state.bootstrap?.legal))}
        onOpenDataAgreement={() => void openExternalUrl(getLegalLinkUrl("data", language, state.bootstrap?.legal))}
      />
    </div>
  );
}
