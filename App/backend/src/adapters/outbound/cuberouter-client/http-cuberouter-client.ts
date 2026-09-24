/** Http cuberouter client module. */
import type {
  CuberouterClient,
  CuberouterErrorCode,
  CuberouterSession,
  CuberouterOrganizationToken,
  CuberouterOrganization
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

    async listOrganizations(accessToken) {
      const data = await request<unknown>(fetchImpl, baseUrl, options.timeoutMs, "/api/organizations", {
        method: "GET",
        accessToken
      });
      // A bare array, not a page: this endpoint answers with every organization the member is in.
      return toOrganizations(Array.isArray(data) ? data : []);
    },

    async listOrganizationTokens(accessToken, organizationId, tokenName) {
      // One page is enough: the server filters by name and status, so a name that exists returns
      // a handful of rows. Paging would only matter for an organization with 100+ same-named keys.
      const query = new URLSearchParams({
        keyword: tokenName,
        status: "1",
        page_size: "100"
      }).toString();
      const response = await request<Record<string, unknown>>(
        fetchImpl,
        baseUrl,
        options.timeoutMs,
        `/api/organizations/${encodeURIComponent(organizationId)}/tokens?${query}`,
        { method: "GET", accessToken, headers: organizationContextHeaders(organizationId) }
      );
      return toOrganizationTokens(Array.isArray(response.items) ? response.items : []);
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
    /** Extra request headers (organization routes need the account-context pair). */
    headers?: Record<string, string>;
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
        ...(input.accessToken ? { authorization: `Bearer ${input.accessToken}` } : {}),
        ...input.headers
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

/**
 * Organization routes act as the organization, not as the person: the instance reads the account
 * context from these two headers and rejects the request when the context is personal (its
 * default) or names a different organization than the path.
 */
function organizationContextHeaders(organizationId: string): Record<string, string> {
  return {
    "X-Account-Context-Type": "organization",
    "X-Account-Context-Id": organizationId
  };
}

/** Maps the organization list onto id/name pairs, dropping rows missing either. */
function toOrganizations(items: unknown[]): CuberouterOrganization[] {
  return items.flatMap((item) => {
    const row = asRecord(item);
    const id = readString(row.id);
    const name = readString(row.name);
    return id && name ? [{ id, name }] : [];
  });
}

/** Maps one organization token page onto id/name/key triples, dropping rows missing any of them. */
function toOrganizationTokens(items: unknown[]): CuberouterOrganizationToken[] {
  return items.flatMap((item) => {
    const row = asRecord(item);
    const id = readCount(row.id);
    const name = readString(row.name);
    const key = readString(row.key);
    return id === null || !name || !key ? [] : [{ id, name, key }];
  });
}

/** Reads a non-negative integer count (a page total); returns null when the field is unusable. */
function readCount(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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
