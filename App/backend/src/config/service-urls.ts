/** Service urls module. */
import { resolveCloudServiceBaseUrl } from "@memmy/local-api-contracts";

export interface CloudClientConfig {
  /** Cloud API base URL. */
  baseUrl: string;
  /** Timeout ms. */
  timeoutMs: number;
}

/** Handles resolve cloud client config. */
export function resolveCloudClientConfig(env: NodeJS.ProcessEnv): CloudClientConfig {
  return {
    baseUrl: env.MEMMY_CLOUD_URL?.trim() || resolveCloudServiceBaseUrl(env.MEMMY_CLOUD_SERVICE),
    timeoutMs: Number.parseInt(env.MEMMY_CLOUD_TIMEOUT_MS ?? "5000", 10)
  };
}

export interface CuberouterClientConfig {
  /** cuberouter base URL without a trailing slash. */
  baseUrl: string;
  /** Fixed model provisioned for desktop users. */
  model: string;
  /** Timeout ms. */
  timeoutMs: number;
}

/** Handles resolve cuberouter client config. */
export function resolveCuberouterClientConfig(env: NodeJS.ProcessEnv): CuberouterClientConfig {
  return {
    baseUrl: (env.MEMMY_CUBEROUTER_URL?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, ""),
    model: env.MEMMY_CUBEROUTER_MODEL?.trim() || "deepseek-flash",
    timeoutMs: Number.parseInt(env.MEMMY_CUBEROUTER_TIMEOUT_MS ?? "10000", 10)
  };
}
