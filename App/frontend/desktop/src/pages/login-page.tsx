/** Login page module. */
import { useApiClients } from "../app/providers.js";
import { AccountAuthPanel } from "../components/account-auth-panel.js";
import { LanguageToggleButton } from "../components/language-toggle-button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";

/** Handles login page. */
export function LoginPage() {
  const { dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t, language } = useTranslation();

  function toggleLanguage() {
    const nextLanguage = language === "en-US" ? "zh-CN" : "en-US";
    dispatch(appActions.settingsUpdated({ language: nextLanguage }));
    void clients?.config.updateSettings({ language: nextLanguage }).catch(() => undefined);
  }

  return (
    <main className="min-h-screen bg-canvas-oat px-4 py-8 flex items-center justify-center relative overflow-hidden">
      <div className="absolute top-[-80px] right-[-60px] w-64 h-64 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-60px] left-[-40px] w-56 h-56 bg-action-sky/10 rounded-full blur-3xl" />

      <LanguageToggleButton language={language} onClick={toggleLanguage} />

      <section className="w-full max-w-md bg-background-paper rounded-card-lg shadow-lg border border-border-stone/60 overflow-hidden relative z-10">
        <div className="px-6 pt-6 pb-3 text-center">
          <div className="flex justify-center mb-1">
            <Memmy pose="wave" size={118} className="memmy-wave" />
          </div>
          <p className="text-sm font-semibold text-text-ink/60">{t("nav.login")}</p>
          <h1 className="text-2xl font-extrabold text-text-ink mt-1">{t("login.title")}</h1>
        </div>
        <div className="px-6 pb-6 space-y-3.5">
          <AccountAuthPanel />
        </div>
      </section>
    </main>
  );
}
