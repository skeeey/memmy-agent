/** Account authentication module. */
import type { CuberouterAuthResult } from "@memmy/local-api-contracts";
import { useCallback, useState } from "react";
import { useApiClients } from "../app/providers.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface AuthFeedback {
  text: string;
  tone: "error" | "success";
}

export type CredentialsValidationResult =
  | { ok: true; username: string; password: string }
  | { ok: false; reason: "username" | "password" | "confirm" };

/** Validates credentials against cuberouter's User rules (8-20 chars, upper + lower + digit). */
export function validateCredentials(input: {
  username: string;
  password: string;
  confirmPassword?: string;
}): CredentialsValidationResult {
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

  return { ok: true, username, password };
}

const validationMessageKeys: Record<"username" | "password" | "confirm", MessageKey> = {
  username: "account.error.username",
  password: "account.error.password",
  confirm: "account.error.confirm"
};

export interface UseAccountAuthResult {
  pending: boolean;
  feedback: AuthFeedback | null;
  register(username: string, password: string, confirmPassword?: string): Promise<CuberouterAuthResult | null>;
  login(username: string, password: string, confirmPassword?: string): Promise<CuberouterAuthResult | null>;
  clearFeedback(): void;
  setFailure(feedback: AuthFeedback): void;
}

export function useAccountAuth(): UseAccountAuthResult {
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<AuthFeedback | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  const authenticate = useCallback(
    async (
      mode: "register" | "login",
      username: string,
      password: string,
      confirmPassword?: string
    ): Promise<CuberouterAuthResult | null> => {
      const validation = validateCredentials({ username, password, confirmPassword });
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
        const credentials = { username: validation.username, password: validation.password };
        return mode === "register"
          ? await clients.account.register(credentials)
          : await clients.account.login(credentials);
      } catch (error) {
        setFeedback({
          text: error instanceof Error && error.message ? error.message : t("account.error.requestFailed"),
          tone: "error"
        });
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
    register: (username, password, confirmPassword) => authenticate("register", username, password, confirmPassword),
    login: (username, password, confirmPassword) => authenticate("login", username, password, confirmPassword),
    clearFeedback,
    setFailure: setFeedback
  };
}
