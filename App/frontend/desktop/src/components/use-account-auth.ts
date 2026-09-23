/** Account authentication module. */
import type { CuberouterAuthResult } from "@memmy/local-api-contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError } from "../api/http.js";
import { useApiClients } from "../app/providers.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface AuthFeedback {
  text: string;
  tone: "error" | "success";
}

export interface CredentialsInput {
  username: string;
  password: string;
  confirmPassword?: string;
  email?: string;
  verificationCode?: string;
  /** True when the target instance demands email verification at registration. */
  emailVerificationRequired?: boolean;
  /** Line a new account is registered on; ignored at login. */
  nodeId?: string;
}

export type CredentialsValidationResult =
  | { ok: true; username: string; password: string; email?: string; verificationCode?: string; nodeId?: string }
  | { ok: false; reason: "username" | "password" | "confirm" | "email" | "verificationCode" };

/**
 * A shape check only: the instance is the authority on what it accepts, and over-strict
 * client rules would reject addresses the server would happily take.
 */
export function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Validates credentials against cuberouter's User rules (8-20 chars, upper + lower + digit). */
export function validateCredentials(input: CredentialsInput): CredentialsValidationResult {
  const username = input.username.trim();
  if (!username || username.length > 50) {
    return { ok: false, reason: "username" };
  }

  const password = input.password;
  if (password.length < 8 || password.length > 20) {
    return { ok: false, reason: "password" };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, reason: "password" };
  }

  if (input.confirmPassword !== undefined && input.confirmPassword !== password) {
    return { ok: false, reason: "confirm" };
  }

  const email = input.email?.trim() ?? "";
  const verificationCode = input.verificationCode?.trim() ?? "";
  // Only enforced when the instance asked for it: otherwise these fields are not on screen,
  // and requiring them would block a login-shaped submit that never had them.
  if (input.emailVerificationRequired) {
    if (!isEmailLike(email)) {
      return { ok: false, reason: "email" };
    }
    if (!verificationCode) {
      return { ok: false, reason: "verificationCode" };
    }
  }

  return {
    ok: true,
    username,
    password,
    ...(email ? { email } : {}),
    ...(verificationCode ? { verificationCode } : {}),
    // Not validated here: the picker only ever offers lines the backend reported, and an
    // unknown one is the backend's to reject.
    ...(input.nodeId ? { nodeId: input.nodeId } : {})
  };
}

const validationMessageKeys: Record<
  "username" | "password" | "confirm" | "email" | "verificationCode",
  MessageKey
> = {
  username: "account.error.username",
  password: "account.error.password",
  confirm: "account.error.confirm",
  email: "account.error.email",
  verificationCode: "account.error.verificationCode"
};

type AuthTranslate = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * Prefers the server's own business message, and falls back to translated copy for
 * anything technical: transport failures ("Failed to fetch"), schema errors, and
 * `internal` envelopes are not user-facing text.
 */
export function toFeedbackText(error: unknown, t: AuthTranslate): string {
  if (error instanceof ApiRequestError && error.code !== null && error.code !== "internal") {
    return error.message || t("account.error.requestFailed");
  }
  return t("account.error.requestFailed");
}

export interface UseAccountAuthResult {
  pending: boolean;
  feedback: AuthFeedback | null;
  register(input: CredentialsInput): Promise<CuberouterAuthResult | null>;
  login(input: CredentialsInput): Promise<CuberouterAuthResult | null>;
  clearFeedback(): void;
  setFailure(feedback: AuthFeedback): void;
}

/** Mirrors cuberouter's own sign-up form, and its two-sends-per-30s window. */
export const EMAIL_CODE_COOLDOWN_SECONDS = 30;

export interface UseEmailVerificationCodeResult {
  sending: boolean;
  secondsLeft: number;
  /** Resolves with the failure copy to show, or `{ ok: true }` once the instance accepted it. */
  send(email: string, nodeId?: string): Promise<{ ok: boolean; text?: string }>;
}

/** Drives the "send verification code" button and its cooldown. */
export function useEmailVerificationCode(): UseEmailVerificationCodeResult {
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Reschedules itself one second at a time rather than holding an interval: the countdown
  // is the only state that changes, so the timeout can simply follow it.
  useEffect(() => {
    if (secondsLeft <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => setSecondsLeft((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const send = useCallback(
    async (email: string, nodeId?: string) => {
      if (!isEmailLike(email)) {
        return { ok: false, text: t("account.error.email") };
      }
      if (!clients || sending || secondsLeft > 0) {
        return { ok: false };
      }

      setSending(true);
      try {
        // The code has to come from the line the account will be created on.
        await clients.account.sendEmailVerificationCode({
          email: email.trim(),
          ...(nodeId ? { nodeId } : {})
        });
        setSecondsLeft(EMAIL_CODE_COOLDOWN_SECONDS);
        return { ok: true };
      } catch (error) {
        // Keeps the instance's own copy (a throttled send answers with "wait N seconds").
        return { ok: false, text: toFeedbackText(error, t) };
      } finally {
        setSending(false);
      }
    },
    [clients, sending, secondsLeft, t]
  );

  return { sending, secondsLeft, send };
}

export function useAccountAuth(): UseAccountAuthResult {
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<AuthFeedback | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  const authenticate = useCallback(
    async (mode: "register" | "login", input: CredentialsInput): Promise<CuberouterAuthResult | null> => {
      const validation = validateCredentials(input);
      if (!validation.ok) {
        setFeedback({ text: t(validationMessageKeys[validation.reason]), tone: "error" });
        return null;
      }

      if (!clients || pending) {
        return null;
      }

      setPending(true);
      setFeedback(null);
      try {
        const credentials = {
          username: validation.username,
          password: validation.password,
          ...(validation.email ? { email: validation.email } : {}),
          ...(validation.verificationCode ? { verificationCode: validation.verificationCode } : {}),
          ...(validation.nodeId ? { nodeId: validation.nodeId } : {})
        };
        return mode === "register"
          ? await clients.account.register(credentials)
          : await clients.account.login(credentials);
      } catch (error) {
        setFeedback({ text: toFeedbackText(error, t), tone: "error" });
        return null;
      } finally {
        setPending(false);
      }
    },
    [clients, pending, t]
  );

  return {
    pending,
    feedback,
    register: (input) => authenticate("register", input),
    login: (input) => authenticate("login", input),
    clearFeedback,
    setFailure: setFeedback
  };
}
