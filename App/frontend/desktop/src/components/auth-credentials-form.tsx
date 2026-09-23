/** Auth credentials form module. */
import { useTranslation } from "../i18n/use-translation.js";

/** Contract for auth credentials form props. */
export interface AuthCredentialsFormProps {
  mode: "register" | "login";
  username: string;
  password: string;
  /** Only rendered in register mode. */
  confirmPassword?: string;
  /** Rendered in register mode only, and only when the instance demands email verification. */
  emailVerificationRequired?: boolean;
  /** Lines a new account may be registered on; the picker appears only when there is a choice. */
  nodes?: string[];
  selectedNodeId?: string | null;
  onNodeChange?: (nodeId: string) => void;
  email?: string;
  verificationCode?: string;
  sendingCode?: boolean;
  /** Seconds left before the code can be requested again; 0 means the button is ready. */
  codeSecondsLeft?: number;
  feedback?: { text: string; tone: "error" | "success" } | null;
  disabled?: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange?: (value: string) => void;
  onEmailChange?: (value: string) => void;
  onVerificationCodeChange?: (value: string) => void;
  onSendCode?: () => void;
  onSubmit: () => void;
  onModeChange: (mode: "register" | "login") => void;
  onOpenTerms?: () => void;
  onOpenDataAgreement?: () => void;
}

const inputClassName = "auth-code-form-input w-full px-5 py-3 border rounded-input text-sm bg-canvas-oat/30 focus:outline-none";

/** Handles auth credentials form. */
export function AuthCredentialsForm(props: AuthCredentialsFormProps) {
  const { t } = useTranslation();
  const errorFeedback = props.feedback?.tone === "error" ? props.feedback : null;

  function submitOnEnter(event: { key: string }) {
    if (event.key === "Enter" && !props.disabled) {
      props.onSubmit();
    }
  }

  const showEmailVerification = props.mode === "register" && props.emailVerificationRequired === true;
  const codeBlocked = props.sendingCode || (props.codeSecondsLeft ?? 0) > 0;

  return (
    <div className="space-y-3.5">
      {/*
        Only in register mode, and only when there is a real choice: the line decides which
        deployment the account lives on, and that is fixed the moment the account exists.
      */}
      {props.mode === "register" && (props.nodes?.length ?? 0) > 1 ? (
        <fieldset className="space-y-2 text-left">
          <legend className="text-xs text-text-ink/60">{t("account.line")}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {props.nodes?.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm text-text-ink/80">
                <input
                  type="radio"
                  name="cuberouter-line"
                  value={id}
                  checked={props.selectedNodeId === id}
                  disabled={props.disabled}
                  onChange={() => props.onNodeChange?.(id)}
                />
                {t(`account.node.${id}` as Parameters<typeof t>[0])}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <input
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={50}
        placeholder={t("account.usernamePlaceholder")}
        value={props.username}
        aria-invalid={Boolean(errorFeedback)}
        onChange={(event) => props.onUsernameChange(event.target.value)}
        onKeyDown={submitOnEnter}
        className={inputClassName}
      />
      {showEmailVerification ? (
        <input
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={50}
          placeholder={t("account.emailPlaceholder")}
          value={props.email ?? ""}
          aria-invalid={Boolean(errorFeedback)}
          onChange={(event) => props.onEmailChange?.(event.target.value)}
          onKeyDown={submitOnEnter}
          className={inputClassName}
        />
      ) : null}
      <input
        type="password"
        autoComplete={props.mode === "register" ? "new-password" : "current-password"}
        placeholder={t("account.passwordPlaceholder")}
        value={props.password}
        aria-invalid={Boolean(errorFeedback)}
        onChange={(event) => props.onPasswordChange(event.target.value)}
        onKeyDown={submitOnEnter}
        className={inputClassName}
      />
      {props.mode === "register" ? (
        <input
          type="password"
          autoComplete="new-password"
          placeholder={t("account.confirmPasswordPlaceholder")}
          value={props.confirmPassword ?? ""}
          aria-invalid={Boolean(errorFeedback)}
          onChange={(event) => props.onConfirmPasswordChange?.(event.target.value)}
          onKeyDown={submitOnEnter}
          className={inputClassName}
        />
      ) : null}
      {showEmailVerification ? (
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={20}
            placeholder={t("account.verificationCodePlaceholder")}
            value={props.verificationCode ?? ""}
            aria-invalid={Boolean(errorFeedback)}
            onChange={(event) => props.onVerificationCodeChange?.(event.target.value)}
            onKeyDown={submitOnEnter}
            className={`${inputClassName} flex-1 min-w-0`}
          />
          <button
            type="button"
            disabled={props.disabled || codeBlocked}
            onClick={props.onSendCode}
            className="auth-code-send shrink-0 px-3 text-xs text-action-sky border border-action-sky/40 rounded-input hover:bg-action-sky/10 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {props.codeSecondsLeft && props.codeSecondsLeft > 0
              ? t("account.resendCode", { seconds: props.codeSecondsLeft })
              : t("account.sendCode")}
          </button>
        </div>
      ) : null}

      {errorFeedback ? (
        <p
          role="alert"
          aria-live="polite"
          title={errorFeedback.text}
          className="text-left text-[12px] font-normal leading-5 text-status-error"
        >
          {errorFeedback.text}
        </p>
      ) : null}

      <p className="auth-code-form-terms text-[10px] text-text-ink/50 text-left leading-snug">
        {t("login.termsPrefix")}
        <button type="button" onClick={props.onOpenTerms} className="text-action-sky hover:underline cursor-pointer">
          {t("login.termsLink")}
        </button>
        {t("login.termsConnector")}
        <button type="button" onClick={props.onOpenDataAgreement} className="text-action-sky hover:underline cursor-pointer">
          {t("login.dataAgreementLink")}
        </button>
        {t("login.termsSuffix")}
      </p>

      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onSubmit}
        className="w-full py-3 bg-action-sky text-white font-semibold rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer shadow-md hover:shadow-lg active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {props.mode === "register" ? t("account.register") : t("account.login")}
      </button>

      <button
        type="button"
        disabled={props.disabled}
        onClick={() => props.onModeChange(props.mode === "register" ? "login" : "register")}
        className="w-full text-center text-xs text-text-ink/60 hover:text-action-sky transition-colors cursor-pointer disabled:opacity-40"
      >
        {props.mode === "register" ? t("account.switchToLogin") : t("account.switchToRegister")}
      </button>
    </div>
  );
}
