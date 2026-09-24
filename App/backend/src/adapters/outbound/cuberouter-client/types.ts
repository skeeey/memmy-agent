/** Cuberouter client types. */

export type CuberouterErrorCode =
  | "two_factor_required"
  | "service_unavailable"
  | "rejected"
  /** The send-code endpoint's own rate limit (two sends per IP per 30s). */
  | "email_code_throttled"
  /** No provisioned organization key, or no permission to read it. */
  | "organization_token_unavailable";

export interface CuberouterSession {
  accessToken: string;
  userId: string;
  username: string;
  displayName: string;
}

/** What the target instance requires before it will accept a registration. */
export interface CuberouterRegistrationRequirements {
  emailVerificationRequired: boolean;
  turnstileRequired: boolean;
  /**
   * The URL the instance names itself with (`server_address`). Admin-configured, so it is only
   * ever a soft signal: a probe compares it against the URL it dialed and logs a mismatch.
   */
  serverAddress: string | null;
}

/** One organization token, with the plaintext key the instance returns to permitted members. */
export interface CuberouterOrganizationToken {
  id: number;
  name: string;
  key: string;
}

/** Default name of the organization token the desktop provisions from. */
export const DESKTOP_TOKEN_NAME = "memmy-desktop";

export interface CuberouterClient {
  register(input: {
    username: string;
    password: string;
    /** Required by the instance when it has email verification enabled. */
    email?: string;
    verificationCode?: string;
  }): Promise<void>;
  login(input: { username: string; password: string }): Promise<CuberouterSession>;
  /** Reads the instance's public status so the form can match what it will accept. */
  getRegistrationRequirements(options?: { timeoutMs?: number }): Promise<CuberouterRegistrationRequirements>;
  /** Asks the instance to email a verification code. */
  sendEmailVerificationCode(email: string): Promise<void>;
  /**
   * Lists the organization's enabled tokens (name-filtered) as the signed-in member. The key is
   * the provisioned API key: organizations hand the full secret to permitted members, which is
   * why the desktop no longer mints a personal token of its own.
   */
  listOrganizationTokens(
    accessToken: string,
    organizationId: string,
    tokenName: string
  ): Promise<CuberouterOrganizationToken[]>;
}
