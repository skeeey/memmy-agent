/** Cuberouter client types. */

export type CuberouterErrorCode = "two_factor_required" | "service_unavailable" | "rejected";

export interface CuberouterSession {
  accessToken: string;
  userId: string;
  username: string;
  displayName: string;
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
  register(input: { username: string; password: string }): Promise<void>;
  login(input: { username: string; password: string }): Promise<CuberouterSession>;
  listTokens(accessToken: string): Promise<CuberouterTokenSummary[]>;
  createToken(accessToken: string, input: { name: string }): Promise<void>;
  getTokenKey(accessToken: string, tokenId: number): Promise<string>;
  getSelf(accessToken: string): Promise<CuberouterProfile>;
}
