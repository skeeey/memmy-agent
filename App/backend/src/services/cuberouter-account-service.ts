/** Cuberouter account service module. */
import type { CuberouterAuthResult } from "@memmy/local-api-contracts";
import type { CuberouterClient, CuberouterErrorCode } from "../adapters/outbound/cuberouter-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { ApiErrorCode } from "./error-envelope.js";

const CUBEROUTER_ERROR_CODES: Record<CuberouterErrorCode, ApiErrorCode> = {
  two_factor_required: "invalid_argument",
  rejected: "invalid_argument",
  service_unavailable: "internal"
};

/**
 * Maps a cuberouter adapter failure onto the local API error contract, keeping the
 * server's own message. Without this every cuberouter rejection surfaces as HTTP 500
 * "internal" (see `withErrorEnvelope`'s unknown-code fallback), so a wrong password
 * would be indistinguishable from a crash.
 */
function toApiError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: CuberouterErrorCode }).code
    : undefined;
  return Object.assign(new Error(message), { code: code ? CUBEROUTER_ERROR_CODES[code] : "internal" });
}

/** Fixed token name used as the idempotency key for desktop provisioning. */
export const MEMORY_DESKTOP_TOKEN_NAME = "memmy-desktop";

export interface CuberouterAccountService {
  register(input: { username: string; password: string }): Promise<CuberouterAuthResult>;
  login(input: { username: string; password: string }): Promise<CuberouterAuthResult>;
  logout(): Promise<{ ok: true }>;
}

export interface CreateCuberouterAccountServiceOptions {
  /** cuberouter REST client. */
  client: CuberouterClient;
  /** Account session repository. */
  accountSessionRepository: AccountSessionRepository;
  /** cuberouter base URL without trailing slash; the model API base appends /v1. */
  baseUrl: string;
  /** Fixed model provisioned for the desktop. */
  model: string;
}

/** Handles to cuberouter account uuid. */
export function toCuberouterAccountUuid(userId: string): string {
  return `cuberouter:${userId}`;
}

/** Creates create cuberouter account service. */
export function createCuberouterAccountService(
  options: CreateCuberouterAccountServiceOptions
): CuberouterAccountService {
  const provisioningApiBase = `${options.baseUrl.replace(/\/+$/, "")}/v1`;

  async function completeLogin(username: string, password: string): Promise<CuberouterAuthResult> {
    const session = await options.client.login({ username, password });
    const apiKey = await ensureApiKey(session.accessToken);
    const projection = options.accountSessionRepository.upsert({
      uuid: toCuberouterAccountUuid(session.userId),
      cloudUuid: session.accessToken,
      // isNewUser is deliberately omitted: the repository decides it from whether a row
      // for that user_id already exists, otherwise every returning user would be sent
      // through onboarding again.
      authChannel: "cuberouter",
      profile: {
        userId: session.userId,
        email: null,
        phoneNumber: null,
        nickname: session.displayName,
        avatarUrl: null,
        planType: null,
        hasFinishedGuide: null,
        region: null,
        registeredAt: null,
        identityProvider: "cuberouter",
        rawProfile: {
          username: session.username,
          displayName: session.displayName
        }
      }
    });

    return {
      session: projection,
      provisioning: { apiKey, apiBase: provisioningApiBase, model: options.model }
    };
  }

  async function ensureApiKey(accessToken: string): Promise<string> {
    const existing = await findToken(accessToken);
    if (existing) {
      return options.client.getTokenKey(accessToken, existing.id);
    }

    await options.client.createToken(accessToken, { name: MEMORY_DESKTOP_TOKEN_NAME });
    // cuberouter does not return the id of the token it just created, so the list has
    // to be read again to find it.
    const created = await findToken(accessToken);
    if (!created) {
      throw Object.assign(new Error("cuberouter 未返回新建的令牌"), { code: "rejected" as const });
    }
    return options.client.getTokenKey(accessToken, created.id);
  }

  async function findToken(accessToken: string) {
    const tokens = await options.client.listTokens(accessToken);
    return tokens.find((token) => token.name === MEMORY_DESKTOP_TOKEN_NAME) ?? null;
  }

  return {
    async register(input) {
      try {
        await options.client.register({ username: input.username, password: input.password });
        return await completeLogin(input.username, input.password);
      } catch (error) {
        throw toApiError(error);
      }
    },

    async login(input) {
      try {
        return await completeLogin(input.username, input.password);
      } catch (error) {
        throw toApiError(error);
      }
    },

    async logout() {
      options.accountSessionRepository.clear();
      return { ok: true };
    }
  };
}
