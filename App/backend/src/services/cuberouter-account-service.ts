/** Cuberouter account service module. */
import type {
  CuberouterAuthInput,
  CuberouterAuthResult
} from "@memmy/local-api-contracts";
import type {
  CuberouterClient,
  CuberouterErrorCode,
  CuberouterRegistrationRequirements
} from "../adapters/outbound/cuberouter-client/index.js";
import type { AccountSessionRepository } from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { CuberouterAccountNodeRepository } from "../infrastructure/app-state-store/repositories/cuberouter-account-node-repo.js";
import type { ApiErrorCode } from "./error-envelope.js";
import { FALLBACK_NODE_ID, type CuberouterNodeRouter } from "./cuberouter-node-router.js";

const CUBEROUTER_ERROR_CODES: Record<CuberouterErrorCode, ApiErrorCode> = {
  two_factor_required: "invalid_argument",
  rejected: "invalid_argument",
  // Transport failures keep their own code rather than folding into "internal": the desktop
  // renders business messages only for codes it knows, so "internal" would swallow the
  // "cannot reach cuberouter" copy that the spec promises on the most likely failure.
  service_unavailable: "cuberouter_unavailable",
  // The send-code rate limit is a 429 on the wire, so it maps onto the existing 429 code
  // and keeps cuberouter's own "wait N seconds" message.
  email_code_throttled: "rate_limited"
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
  register(input: CuberouterAuthInput & { nodeId?: string }): Promise<CuberouterAuthResult>;
  login(input: { username: string; password: string }): Promise<CuberouterAuthResult>;
  /** Probes the target instance so the form matches what it will accept. */
  getRegistrationRequirements(nodeId?: string): Promise<CuberouterRegistrationRequirements>;
  /** Asks the target instance to email a verification code, for the line the caller picked. */
  sendEmailVerificationCode(email: string, nodeId?: string): Promise<{ ok: true }>;
  /** The configured lines and the one currently in effect. */
  getNodes(): Promise<{ nodes: string[]; currentNodeId: string | null }>;
  /** Measures every line and reports which one a first registration should use. */
  probeNodes(): Promise<{ nodes: string[]; defaultNodeId: string | null }>;
  logout(): Promise<{ ok: true }>;
}

export interface CreateCuberouterAccountServiceOptions {
  /** Builds a client for one node's URL. */
  clientFor: (url: string) => CuberouterClient;
  /** Account session repository. */
  accountSessionRepository: AccountSessionRepository;
  /** Which line each account was registered on. */
  accountNodes: CuberouterAccountNodeRepository;
  /** Node table, probing and the current line. */
  nodeRouter: CuberouterNodeRouter;
  /** Fixed model provisioned for the desktop. */
  model: string;
  log?: (message: string) => void;
}

/** Handles to cuberouter account uuid. */
export function toCuberouterAccountUuid(userId: string): string {
  return `cuberouter:${userId}`;
}

/** Creates create cuberouter account service. */
export function createCuberouterAccountService(
  options: CreateCuberouterAccountServiceOptions
): CuberouterAccountService {
  const log = options.log ?? (() => undefined);

  /** Resolves a node id to its URL and client. An id outside the table is a caller bug. */
  function clientForNode(nodeId: string): { client: CuberouterClient; url: string } {
    const url = options.nodeRouter.getNodeUrl(nodeId);
    if (!url) {
      throw Object.assign(new Error("未知的线路"), { code: "invalid_argument" as const });
    }
    return { client: options.clientFor(url), url };
  }

  /**
   * Applies the build's fallback rule to a probe result: nothing reachable means the default
   * line, and a single-node table (pinned URL) has only itself to offer. Returns null when the
   * table holds nothing usable — a caller that cannot offer any line must say so, never name one
   * that does not exist.
   */
  function withFallback(probed: string | null): string | null {
    if (options.nodeRouter.getNodeUrl(probed ?? "")) {
      return probed!;
    }
    if (options.nodeRouter.getNodeUrl(FALLBACK_NODE_ID)) {
      return FALLBACK_NODE_ID;
    }
    return options.nodeRouter.listNodes()[0]?.id ?? null;
  }

  /** Where a first registration should go when the caller did not pick: the probed default. */
  async function defaultNodeId(): Promise<string> {
    const resolved = withFallback((await options.nodeRouter.probe()).defaultNodeId);
    if (!resolved) {
      throw Object.assign(new Error("没有可用的 cuberouter 线路"), { code: "invalid_argument" as const });
    }
    return resolved;
  }

  /** The line a returning caller is already on: the stored one, else the probed default. */
  async function currentOrProbedNodeId(): Promise<string> {
    const preferred = await options.nodeRouter.getPreferredNodeId();
    return options.nodeRouter.getNodeUrl(preferred ?? "") ? preferred! : await defaultNodeId();
  }

  /**
   * Login candidates, most likely first: the remembered line, the current line, then the
   * probed default and the build's fallback. Only the first two are tried — the two deployments
   * hold separate accounts, so a third attempt would only add latency and login rate-limit risk.
   */
  async function loginOrder(username: string): Promise<string[]> {
    const inTable = (nodeId: string | null | undefined): nodeId is string =>
      Boolean(nodeId) && options.nodeRouter.getNodeUrl(nodeId!) !== null;
    const known = [
      options.accountNodes.get(username),
      await options.nodeRouter.getPreferredNodeId()
    ].filter(inTable);

    // With a line already known the first slot is decided, and the second is whatever else the
    // table holds — measuring the lines could not change the order, so it must not cost the user
    // its latency (up to four status calls) before the first login attempt.
    if (known.length > 0) {
      return [...new Set([...known, ...options.nodeRouter.listNodes().map((node) => node.id)])].slice(0, 2);
    }

    const probed = withFallback((await options.nodeRouter.probe()).defaultNodeId);
    return [...new Set([probed, FALLBACK_NODE_ID, ...options.nodeRouter.listNodes().map((node) => node.id)])]
      .filter(inTable)
      .slice(0, 2);
  }

  /** Runs one login against one node and records it as the account's line. */
  async function loginOnNode(
    nodeId: string,
    username: string,
    password: string
  ): Promise<CuberouterAuthResult> {
    const { client, url } = clientForNode(nodeId);
    const session = await client.login({ username, password });
    const apiKey = await ensureApiKey(client, session.accessToken);
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
    options.accountNodes.set(username, nodeId);
    await options.nodeRouter.setPreferredNodeId(nodeId);
    log(`[cuberouter] ${username} is on ${nodeId} (${url})`);

    return {
      session: projection,
      provisioning: { apiKey, apiBase: `${url}/v1`, model: options.model }
    };
  }

  async function ensureApiKey(client: CuberouterClient, accessToken: string): Promise<string> {
    const existing = await findToken(client, accessToken);
    if (existing) {
      return client.getTokenKey(accessToken, existing.id);
    }

    await client.createToken(accessToken, { name: MEMORY_DESKTOP_TOKEN_NAME });
    // cuberouter does not return the id of the token it just created, so the list has
    // to be read again to find it.
    const created = await findToken(client, accessToken);
    if (!created) {
      throw Object.assign(new Error("cuberouter 未返回新建的令牌"), { code: "rejected" as const });
    }
    return client.getTokenKey(accessToken, created.id);
  }

  async function findToken(client: CuberouterClient, accessToken: string) {
    const tokens = await client.listTokens(accessToken);
    return tokens.find((token) => token.name === MEMORY_DESKTOP_TOKEN_NAME) ?? null;
  }

  return {
    async register(input) {
      // Resolved once, before the try: the account must be created and then logged into on the
      // SAME node, and an unknown node id has to keep its own error code (the adapter mapping
      // below only knows cuberouter's codes and would fold anything else into internal).
      const nodeId = input.nodeId ?? await defaultNodeId();
      const { client, url } = clientForNode(nodeId);

      try {
        await client.register({
          username: input.username,
          password: input.password,
          ...(input.email ? { email: input.email } : {}),
          ...(input.verificationCode ? { verificationCode: input.verificationCode } : {})
        });
        return await loginOnNode(nodeId, input.username, input.password);
      } catch (error) {
        log(`[cuberouter] register/login on ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw toApiError(error);
      }
    },

    async getRegistrationRequirements(nodeId) {
      // The two deployments can differ (email verification, Turnstile), so this reads the line
      // the caller is looking at rather than whatever was read last.
      const { client } = clientForNode(nodeId ?? await currentOrProbedNodeId());
      try {
        return await client.getRegistrationRequirements();
      } catch (error) {
        throw toApiError(error);
      }
    },

    async sendEmailVerificationCode(email, nodeId) {
      // The code is instance-local, so it must be requested from the line the account will be
      // created on — the current line would produce a code the selected one cannot validate.
      const { client } = clientForNode(nodeId ?? await currentOrProbedNodeId());
      try {
        await client.sendEmailVerificationCode(email);
        return { ok: true as const };
      } catch (error) {
        throw toApiError(error);
      }
    },

    async getNodes() {
      const nodes = options.nodeRouter.listNodes().map((node) => node.id);
      const preferred = await options.nodeRouter.getPreferredNodeId();
      return { nodes, currentNodeId: preferred && nodes.includes(preferred) ? preferred : null };
    },

    async probeNodes() {
      const nodes = options.nodeRouter.listNodes().map((node) => node.id);
      // The UI preselects whatever this returns, so the fallback (nothing reachable → the
      // build's default line) is applied here rather than left for the caller to guess.
      return { nodes, defaultNodeId: withFallback((await options.nodeRouter.probe()).defaultNodeId) };
    },

    async login(input) {
      const order = await loginOrder(input.username);
      if (order.length === 0) {
        throw Object.assign(new Error("没有可用的 cuberouter 线路"), { code: "invalid_argument" as const });
      }

      let lastError: Error | null = null;
      for (const nodeId of order) {
        try {
          return await loginOnNode(nodeId, input.username, input.password);
        } catch (error) {
          lastError = toApiError(error);
          log(
            `[cuberouter] login on ${nodeId} failed, trying the next line: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // Same shape the desktop shows today: with separate accounts per node, a rejection on
      // both sides means wrong credentials just as often as it means the wrong line.
      throw lastError ?? Object.assign(new Error("cuberouter 登录失败"), { code: "internal" as const });
    },

    async logout() {
      options.accountSessionRepository.clear();
      return { ok: true };
    }
  };
}
