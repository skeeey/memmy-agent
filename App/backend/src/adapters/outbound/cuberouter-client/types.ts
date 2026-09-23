/** Cuberouter client types. */

export type CuberouterErrorCode =
  | "two_factor_required"
  | "service_unavailable"
  | "rejected"
  /** The send-code endpoint's own rate limit (two sends per IP per 30s). */
  | "email_code_throttled";

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

export interface CuberouterTokenSummary {
  id: number;
  name: string;
}

export interface CuberouterProfile {
  userId: string;
  username: string;
  displayName: string;
  quota: number;
}

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
  listTokens(accessToken: string): Promise<CuberouterTokenSummary[]>;
  createToken(accessToken: string, input: { name: string }): Promise<void>;
  getTokenKey(accessToken: string, tokenId: number): Promise<string>;
  getSelf(accessToken: string): Promise<CuberouterProfile>;
}
