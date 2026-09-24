/** Service urls module. */
import { resolveCloudServiceBaseUrl } from "@memmy/local-api-contracts";
import type { CuberouterSettings } from "../infrastructure/memmy-config/cuberouter-access.js";

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
  /** Organization whose `memmy-desktop` token supplies the API key; null when unconfigured. */
  organizationId: string | null;
}

/** Handles resolve cuberouter client config. Environment wins over the config file. */
export function resolveCuberouterClientConfig(
  env: NodeJS.ProcessEnv,
  settings: CuberouterSettings = {}
): CuberouterClientConfig {
  const baseUrl = env.MEMMY_CUBEROUTER_URL?.trim() || settings.baseUrl?.trim() || "http://127.0.0.1:3000";
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: env.MEMMY_CUBEROUTER_MODEL?.trim() || settings.model?.trim() || "deepseek-flash",
    timeoutMs: Number.parseInt(env.MEMMY_CUBEROUTER_TIMEOUT_MS ?? "", 10) || settings.timeoutMs || 10_000,
    organizationId: env.MEMMY_CUBEROUTER_ORG?.trim() || null
  };
}
