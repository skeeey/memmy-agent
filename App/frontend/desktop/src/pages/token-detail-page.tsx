/** Token detail page module. */
import { Check, ChevronLeft } from "lucide-react";
import { useApiClients } from "../app/providers.js";
import { AccountAuthPanel } from "../components/account-auth-panel.js";
import { LanguageToggleButton, PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { formatTokenGiftAmount } from "./token-gift.js";

export function TokenDetailPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t, language } = useTranslation();
  const agentChatTokenTotal = state.bootstrap?.promotions?.agentChatTokenTotal;

  function toggleLanguage() {
    const nextLanguage = language === "en-US" ? "zh-CN" : "en-US";
    dispatch(appActions.settingsUpdated({ language: nextLanguage }));
    void clients?.config.updateSettings({ language: nextLanguage }).catch(() => undefined);
  }

  return (
    <main className="h-screen flex flex-col bg-canvas-oat relative overflow-hidden">
      <div className="absolute top-[-60px] left-[-40px] w-48 h-48 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-80px] right-[-60px] w-64 h-64 bg-action-sky/10 rounded-full blur-3xl" />

      <div
        className="flex items-center gap-[calc(0.5rem*2/3)]"
        style={PAGE_CORNER_ACTION_CONTAINER_STYLE}
      >
        <PageCornerActionButton
          label={t("welcome.gift.detail.backShort")}
          ariaLabel={t("welcome.gift.detail.back")}
          onClick={() => dispatch(appActions.navigate("/welcome"))}
          className="-mr-1"
          icon={<ChevronLeft aria-hidden="true" size={16} strokeWidth={2.2} className="shrink-0 -mr-0.5" />}
        />
        <LanguageToggleButton language={language} onClick={toggleLanguage} embedded />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4 relative z-10 min-h-0 overflow-y-auto py-6">
        <section className="w-full max-w-md">
          <div className="bg-gradient-to-br from-action-sky to-action-sky-hover rounded-card-lg p-7 text-white text-center mb-6 relative overflow-hidden">
            <div className="absolute top-3 right-4 w-16 h-16 bg-white/10 rounded-full" />
            <div className="absolute bottom-2 left-4 w-12 h-12 bg-white/5 rounded-full" />
            <div className="text-3xl font-extrabold tracking-tight">
              {formatTokenGiftAmount(agentChatTokenTotal)}
            </div>
            <div className="text-sm text-white/70 mt-1">{t("welcome.gift.detail.subtitle")}</div>
            <div
              className={`mt-5 space-y-2 text-left mx-auto ${language === "en-US" ? "w-full" : "max-w-xs"}`}
            >
              <TokenGiftBenefit text={t("welcome.gift.detail.bullet.conversations")} />
              <TokenGiftBenefit text={t("welcome.gift.detail.bullet.memories")} />
              <TokenGiftBenefit text={t("welcome.gift.detail.bullet.features")} />
            </div>
          </div>

          <div className="welcome-login-card shadow-lg overflow-hidden">
            <div className="welcome-login-card__body welcome-login-card__body--no-banner px-6">
              <AccountAuthPanel />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * Renders a Token benefit row.
 *
 * @param props.text The benefit description text.
 * @returns A benefit row node with a check icon.
 */
function TokenGiftBenefit(props: { text: string }) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Check size={15} className="mt-0.5 shrink-0 text-white/60" />
      <span>{props.text}</span>
    </div>
  );
}
