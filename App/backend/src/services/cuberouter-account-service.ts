/** Cuberouter account service module. */
import type {
  CuberouterAuthInput,
  CuberouterAuthResult
} from "@memmy/local-api-contracts";
import {
  DESKTOP_TOKEN_NAME,
  type CuberouterClient,
  type CuberouterErrorCode,
  type CuberouterRegistrationRequirements
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
  email_code_throttled: "rate_limited",
  // No provisioned key, or no permission to read it: the member has to ask an administrator.
  organization_token_unavailable: "cuberouter_key_unavailable"
};

/**
 * The cuberouter error code a failure carries, when the adapter gave it one. Read raw rather than
 * through the mapped `ApiErrorCode`: several cuberouter codes map onto one local code, and the
 * caller here needs to tell them apart.
 */
function cuberouterCode(error: unknown): CuberouterErrorCode | undefined {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: CuberouterErrorCode }).code
    : undefined;
}

/**
 * Maps a cuberouter adapter failure onto the local API error contract, keeping the
 * server's own message. Without this every cuberouter rejection surfaces as HTTP 500
 * "internal" (see `withErrorEnvelope`'s unknown-code fallback), so a wrong password
 * would be indistinguishable from a crash.
 */
function toApiError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = cuberouterCode(error);
  return Object.assign(new Error(message), { code: code ? CUBEROUTER_ERROR_CODES[code] : "internal" });
}

export interface CuberouterAccountService {
  register(input: CuberouterAuthInput & { nodeId?: string }): Promise<CuberouterAuthResult>;
  login(input: { username: string; password: string; nodeId?: string }): Promise<CuberouterAuthResult>;
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
  /** Organization whose token supplies the API key; null when unconfigured. */
  organizationId: string | null;
  /** Prefix of the per-account token name; null means the built-in default. */
  organizationTokenNamePrefix: string | null;
  log?: (message: string) => void;
}

/** Handles to cuberouter account uuid. */
export function toCuberouterAccountUuid(userId: string): string {
  return `cuberouter:${userId}`;
}

/**
 * The organization token an account reads. One key per person, named after the account, so the
 * instance's console attributes a key to whoever holds it instead of pooling everyone behind one
 * name. Usernames are email addresses on these deployments, and the domain says nothing about
 * which person is asking; the local part is the part an administrator recognizes.
 *
 * Case and punctuation are kept exactly as the instance stores them: cuberouter usernames are
 * case-sensitive, so a folded name would simply not match the key that was created.
 */
export function toDesktopTokenName(username: string, prefix: string = DESKTOP_TOKEN_NAME): string {
  const trimmed = username.trim();
  const domain = trimmed.indexOf("@");
  const local = domain > 0 ? trimmed.slice(0, domain) : trimmed;
  return `${prefix}-${local.trim()}`;
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
  async function loginOrder(username: string, pickedNodeId?: string): Promise<string[]> {
    const inTable = (nodeId: string | null | undefined): nodeId is string =>
      Boolean(nodeId) && options.nodeRouter.getNodeUrl(nodeId!) !== null;
    const known = [
      pickedNodeId,
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

  /**
   * Resolves the configured organization to the id this instance uses for it. A build names the
   * organization because the two deployments number it independently, so the id is looked up per
   * line; an all-digit setting is taken as the id itself (local development, single-instance setups).
   */
  async function resolveOrganizationId(
    client: CuberouterClient,
    accessToken: string,
    configured: string
  ): Promise<string> {
    if (/^\d+$/.test(configured)) {
      return configured;
    }

    const organizations = await client.listOrganizations(accessToken);
    const match = organizations.find((organization) => organization.name === configured);
    if (!match) {
      throw Object.assign(new Error(`未找到组织「${configured}」，请联系管理员确认`), {
        code: "organization_token_unavailable" as const
      });
    }
    return match.id;
  }

  /** Runs one login against one node and records it as the account's line. */
  async function loginOnNode(
    nodeId: string,
    username: string,
    password: string
  ): Promise<CuberouterAuthResult> {
    const { client, url } = clientForNode(nodeId);
    const session = await client.login({ username, password });
    // The name comes from what the instance reports, never from the typed string: an alias would
    // name a key nobody created.
    const apiKey = await ensureOrganizationKey(client, session.accessToken, session.username);
    // "New" is a question about this machine, and the account row is the wrong place to ask it:
    // a row whose uuid was written under a different spelling re-appears as new, and "new"
    // resets the guidance. The line memory is per username, survives a logout, and is written
    // by every successful login — so it answers exactly this.
    const seenBefore = options.accountNodes.get(username) !== null;
    const projection = options.accountSessionRepository.upsert({
      uuid: toCuberouterAccountUuid(session.userId),
      cloudUuid: session.accessToken,
      isNewUser: !seenBefore,
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

  /**
   * The account's API key inside the organization, read back when it exists and created when it
   * does not. The name is the account's (see `toDesktopTokenName`), so an administrator's
   * hand-provisioned key and this account's own key are the same key: the read comes first and a
   * returning account reuses what it — or the operator — already made. Only a miss creates.
   *
   * A created key takes the shape the console's own create form defaults to: held by this
   * account, private to it, and unlimited — the organization's pool is the budget, and a
   * per-key quota would strand the key the moment it ran out.
   */
  async function ensureOrganizationKey(
    client: CuberouterClient,
    accessToken: string,
    username: string
  ): Promise<string> {
    if (!options.organizationId) {
      throw Object.assign(
        new Error("未配置组织（MEMMY_CUBEROUTER_ORG），无法获取 API Key"),
        { code: "organization_token_unavailable" as const }
      );
    }

    const tokenName = toDesktopTokenName(
      username,
      options.organizationTokenNamePrefix ?? DESKTOP_TOKEN_NAME
    );
    const organizationId = await resolveOrganizationId(client, accessToken, options.organizationId);
    const tokens = await client.listOrganizationTokens(accessToken, organizationId, tokenName);
    // Exact match after the server's name filter: the filter is a substring match, so a longer
    // name that merely starts with this account's (a second key, say) is not ours.
    const provisioned = tokens.find((token) => token.name === tokenName);
    if (provisioned) {
      return provisioned.key;
    }

    try {
      const created = await client.createOrganizationToken(accessToken, organizationId, {
        name: tokenName,
        unlimitedQuota: true
      });
      log(`[cuberouter] created organization key ${tokenName} for ${username}`);
      return created.key;
    } catch (error) {
      // Say what the desktop was doing, and keep the instance's own sentence: the same refusal
      // ("permission denied") means something different at login than at creation, and the
      // reason — not a membership, a name too long, the key limit reached — lives in that text.
      //
      // Never the raw code: `rejected` is how the login loop recognises wrong credentials, and
      // this account has just authenticated. What failed is the key, not the password.
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`创建组织 API Key（${tokenName}）失败：${message}`), {
        code: "organization_token_unavailable" as const
      });
    }
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
      const order = await loginOrder(input.username, input.nodeId);
      if (order.length === 0) {
        throw Object.assign(new Error("没有可用的 cuberouter 线路"), { code: "invalid_argument" as const });
      }

      let lastError: Error | null = null;
      // Held back rather than reported: see the rule below the loop.
      let rejection: Error | null = null;
      for (const nodeId of order) {
        try {
          return await loginOnNode(nodeId, input.username, input.password);
        } catch (error) {
          const apiError = toApiError(error);
          // A rejection only means "wrong credentials" when nothing else went wrong. The lines
          // hold separate accounts, so the line this one is not on answers with a rejection every
          // time — reporting it would tell a visitor who typed the right password that it is
          // wrong, and bury the failure they could have acted on.
          if (cuberouterCode(error) === "rejected") {
            rejection = apiError;
          } else {
            lastError = apiError;
          }
          log(
            `[cuberouter] login on ${nodeId} failed, trying the next line: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // With both lines rejecting, wrong credentials remain the likeliest reading: the account
      // exists on one of them, and the visitor is on the wrong one just as often.
      throw lastError ?? rejection ?? Object.assign(new Error("cuberouter 登录失败"), { code: "internal" as const });
    },

    async logout() {
      options.accountSessionRepository.clear();
      return { ok: true };
    }
  };
}
