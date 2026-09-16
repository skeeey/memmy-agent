/** Welcome page module. */
import { Gift, Key } from "lucide-react";
import { useState } from "react";
import { useAnalytics } from "../analytics/use-analytics.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { resolveByokEntry } from "../app/routes.js";
import { AccountAuthPanel } from "../components/account-auth-panel.js";
import { LanguageToggleButton } from "../components/language-toggle-button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { formatTokenGiftAmount } from "./token-gift.js";

/** Handles welcome page. */
export function WelcomePage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { track } = useAnalytics();
  const { t, language } = useTranslation();
  const [modePersistencePending, setModePersistencePending] = useState(false);
  const [modePersistenceFeedback, setModePersistenceFeedback] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const agentChatTokenTotal = state.bootstrap?.promotions?.agentChatTokenTotal;
  const showLoginBanner =
    (state.bootstrap?.promotions?.loginBanner ?? true) && (agentChatTokenTotal ?? 0) > 0;

  /** Handles toggle language. */
  function toggleLanguage() {
    const nextLanguage = language === "en-US" ? "zh-CN" : "en-US";
    setModePersistenceFeedback(null);
    dispatch(appActions.settingsUpdated({ language: nextLanguage }));
    void clients?.config.updateSettings({ language: nextLanguage }).catch(() => undefined);
  }

  /** Handles use own api key. */
  async function useOwnApiKey() {
    if (modePersistencePending) {
      return;
    }

    // Definition for byok entry.
    const byokEntry = resolveByokEntry({
      onboarding: state.bootstrap?.onboarding,
      modelConfig: state.modelConfig
    });

    track({ name: "byok_started", params: { user_mode: "byok" }, consentTier: "basic" });
    setModePersistenceFeedback(null);

    try {
      setModePersistencePending(true);
      await persistLoginModeSelection({
        configClient: clients?.config,
        dispatch,
        userMode: "byok",
        onboarding: byokEntry.onboardingPatch
      });
      dispatch(appActions.navigate(byokEntry.nextRoute));
    } catch (error) {
      console.error("persist byok entry failed", error);
      setModePersistenceFeedback({ text: t("login.error.modePersistenceFailed"), tone: "error" });
    } finally {
      setModePersistencePending(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-canvas-oat relative overflow-hidden">
      <div className="absolute top-[-80px] right-[-60px] w-64 h-64 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-60px] left-[-40px] w-56 h-56 bg-action-sky/10 rounded-full blur-3xl" />
      <div className="absolute top-[40%] left-[10%] w-40 h-40 bg-action-sky/15 rounded-full blur-3xl" />

      <LanguageToggleButton language={language} onClick={toggleLanguage} />

      <div className="flex-1 flex flex-col items-center justify-center px-4 relative z-10 min-h-0">
        <div className="w-full max-w-md flex flex-col items-center">
          <div className="text-center mb-6">
            <div className="welcome-brand-mascot flex justify-center">
              <Memmy pose="wave" size={176} className="memmy-wave" />
            </div>
            <span className="text-3xl font-extrabold tracking-tight text-text-ink">{t("brand.name")}</span>
            <p className="welcome-brand-subtitle text-base text-text-ink/50">{t("brand.subtitle")}</p>
          </div>

          <div className="w-full">
            <div className="welcome-login-card shadow-lg overflow-hidden">
            {/* Welcome page module. */}
            {showLoginBanner && (
              <button
                type="button"
                onClick={() => dispatch(appActions.navigate("/token-detail"))}
                aria-label={t("welcome.gift.expand")}
                className="welcome-login-card__banner w-full flex items-center gap-2.5 text-left cursor-pointer"
              >
                <span className="w-6 h-6 rounded-full bg-action-sky/15 flex items-center justify-center text-action-sky shrink-0">
                  <Gift size={14} strokeWidth={2.2} />
                </span>
                <span className="text-sm text-text-ink/70">
                  {t("welcome.gift", { count: formatTokenGiftAmount(agentChatTokenTotal) })}
                </span>
              </button>
            )}

            <div className={`welcome-login-card__body px-6${showLoginBanner ? " welcome-login-card__body--with-banner" : " welcome-login-card__body--no-banner"}`}>
              <AccountAuthPanel />
            </div>
          </div>

          <div className="flex items-center gap-3 mt-4 mb-4">
            <div className="flex-1 h-px bg-border-stone/60" />
            <span className="text-xs text-text-ink/45">{t("welcome.or")}</span>
            <div className="flex-1 h-px bg-border-stone/60" />
          </div>

          <button
            type="button"
            disabled={modePersistencePending}
            onClick={() => void useOwnApiKey()}
            className="welcome-byok-action w-full flex items-center justify-center gap-2.5 py-3 text-sm text-text-ink/75 hover:text-action-sky transition-all cursor-pointer shadow-sm disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Key size={15} />
            {t("welcome.byok.quickAction")}
          </button>

          {modePersistenceFeedback ? (
            <p
              role="alert"
              aria-live="polite"
              className="welcome-byok-action-feedback w-full text-left text-[12px] font-normal leading-5 text-status-error"
            >
              {modePersistenceFeedback.text}
            </p>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
