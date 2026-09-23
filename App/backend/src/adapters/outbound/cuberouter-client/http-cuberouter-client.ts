/** Http cuberouter client module. */
import type {
  CuberouterClient,
  CuberouterErrorCode,
  CuberouterProfile,
  CuberouterSession,
  CuberouterTokenSummary
} from "./types.js";

export interface CreateHttpCuberouterClientOptions {
  /** Base url, already trimmed of trailing slashes. */
  baseUrl: string;
  /** Timeout ms. */
  timeoutMs: number;
  /** Fetch impl. */
  fetchImpl?: typeof fetch;
}

interface CuberouterEnvelope {
  success?: boolean;
  message?: string;
  data?: unknown;
}

/** Creates create http cuberouter client. */
export function createHttpCuberouterClient(options: CreateHttpCuberouterClientOptions): CuberouterClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async register(input) {
      await request(fetchImpl, baseUrl, options.timeoutMs, "/api/user/register", {
        method: "POST",
        body: {
          username: input.username,
          password: input.password,
          // Only sent when the caller collected them: the field names are cuberouter's, and
          // an instance without email verification ignores them but need not receive them.
          ...(input.email ? { email: input.email } : {}),
          ...(input.verificationCode ? { verification_code: input.verificationCode } : {})
        }
      });
    },

    async getRegistrationRequirements(probeOptions) {
      const data = await request<Record<string, unknown>>(
        fetchImpl,
        baseUrl,
        probeOptions?.timeoutMs ?? options.timeoutMs,
        "/api/status",
        { method: "GET" }
      );
      // Strict true, and absent means false: an instance that renames or drops these fields
      // must degrade to the plain form rather than to one that can never submit.
      return {
        emailVerificationRequired: data.email_verification === true,
        turnstileRequired: data.turnstile_check === true,
        serverAddress: readString(data.server_address) ?? null
      };
    },

    async sendEmailVerificationCode(email) {
      const query = new URLSearchParams({ email }).toString();
      await request(fetchImpl, baseUrl, options.timeoutMs, `/api/verification?${query}`, {
        method: "GET",
        tooManyRequestsCode: "email_code_throttled"
      });
    },

    async login(input) {
      const data = await request<Record<string, unknown>>(fetchImpl, baseUrl, options.timeoutMs, "/api/user/login", {
        method: "POST",
        body: { username: input.username, password: input.password }
      });
      if (data.require_2fa === true) {
        throw cuberouterError("two_factor_required", "该账号启用了两步验证，本版本不支持");
      }
      const accessToken = readString(data.access_token);
      const user = asRecord(data.user);
      const userId = readString(user.id) ?? readString(user.userId);
      if (!accessToken || !userId) {
        throw cuberouterError("rejected", "cuberouter 登录响应缺少访问令牌");
      }
      const username = readString(user.username) ?? input.username;
      return {
        accessToken,
        userId,
        username,
        displayName: readString(user.display_name) ?? username
      };
    },

    async listTokens(accessToken) {
      const requestedPageSize = 100;
      const tokens: CuberouterTokenSummary[] = [];
      // Read every page, not just the first: a caller scanning for an existing token by name
      // would otherwise miss one that sits on a later page, creating a duplicate on every
      // login until the per-user token cap turns that into a permanent login failure.
      for (let page = 1; ; page += 1) {
        const response = await request<Record<string, unknown>>(
          fetchImpl,
          baseUrl,
          options.timeoutMs,
          `/api/token/?p=${page}&page_size=${requestedPageSize}`,
          { method: "GET", accessToken }
        );
        const items = Array.isArray(response.items) ? response.items : [];
        tokens.push(...toTokenSummaries(items));

        const total = readCount(response.total);
        // Trust the page size the server reports over the one requested: it may cap it.
        const pageSize = readPositiveCount(response.page_size) ?? requestedPageSize;
        if (items.length === 0 || total === null || page * pageSize >= total) {
          return tokens;
        }
      }
    },

    async createToken(accessToken, input) {
      await request(fetchImpl, baseUrl, options.timeoutMs, "/api/token/", {
        method: "POST",
        accessToken,
        body: {
          name: input.name,
          expired_time: -1,
          unlimited_quota: true,
          remain_quota: 0,
          model_limits_enabled: false,
          group: ""
        }
      });
    },

    async getTokenKey(accessToken, tokenId) {
      const data = await request<Record<string, unknown>>(
        fetchImpl,
        baseUrl,
        options.timeoutMs,
        `/api/token/${tokenId}/key`,
        { method: "POST", accessToken }
      );
      const key = readString(data.key);
      if (!key) throw cuberouterError("rejected", "cuberouter 未返回令牌明文");
      return key;
    },

    async getSelf(accessToken) {
      const data = await request<Record<string, unknown>>(fetchImpl, baseUrl, options.timeoutMs, "/api/user/self", {
        method: "GET",
        accessToken
      });
      const username = readString(data.username) ?? "";
      return {
        userId: readString(data.id) ?? "",
        username,
        displayName: readString(data.display_name) ?? username,
        quota: typeof data.quota === "number" ? data.quota : 0
      } satisfies CuberouterProfile;
    }
  };
}

async function request<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  path: string,
  input: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    accessToken?: string;
    /** Error code to raise instead of "rejected" when this call answers 429. */
    tooManyRequestsCode?: CuberouterErrorCode;
  }
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: input.method,
      headers: {
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {})
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Read the body inside the try as well: a timeout or transport failure can also
    // surface while the body is streaming, and it must carry the same error code.
    text = await response.text();
  } catch {
    throw cuberouterError("service_unavailable", "无法连接 cuberouter 服务，请检查服务地址与网络");
  }

  const envelope = parseEnvelope(text);

  // Checked before the generic rejection so a throttled send keeps its own code: the desktop
  // shows a different (retry-shaped) message for it than for a plain rejection.
  if (response.status === 429 && input.tooManyRequestsCode) {
    throw cuberouterError(input.tooManyRequestsCode, envelope.message || "请求过于频繁，请稍后再试");
  }

  if (!response.ok || envelope.success !== true) {
    throw cuberouterError("rejected", envelope.message || `cuberouter 请求失败（HTTP ${response.status}）`);
  }

  return (envelope.data ?? {}) as T;
}

function parseEnvelope(text: string): CuberouterEnvelope {
  if (!text) return {};
  try {
    return JSON.parse(text) as CuberouterEnvelope;
  } catch {
    return {};
  }
}

function cuberouterError(code: CuberouterErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Maps one token page onto the id/name summary, dropping rows without a usable id or name. */
function toTokenSummaries(items: unknown[]): CuberouterTokenSummary[] {
  return items.flatMap((item) => {
    const record = asRecord(item);
    const id = typeof record.id === "number" ? record.id : Number.parseInt(String(record.id ?? ""), 10);
    const name = readString(record.name);
    return Number.isFinite(id) && name ? [{ id, name }] : [];
  });
}

/** Reads a non-negative integer count (a page total); returns null when the field is unusable. */
function readCount(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Reads a positive integer count (a page size); returns null so a reported 0 cannot stall paging. */
function readPositiveCount(value: unknown): number | null {
  const parsed = readCount(value);
  return parsed === null || parsed < 1 ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}
