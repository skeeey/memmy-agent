/** Node table for multi-region cuberouter deployments. */
import type { CuberouterSettings } from "../infrastructure/memmy-config/cuberouter-access.js";

export interface CuberouterNode {
  id: string;
  url: string;
}

/** Parses `id=url,id=url`; unusable entries are dropped rather than failing the whole table. */
export function parseCuberouterNodeTable(raw: string): CuberouterNode[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        return [];
      }
      const id = entry.slice(0, separator).trim();
      const url = entry.slice(separator + 1).trim().replace(/\/+$/, "");
      return id && /^https?:\/\//.test(url) ? [{ id, url }] : [];
    });
}

/** The deployments a build talks to when nothing overrides them. */
export const DEFAULT_CUBEROUTER_NODES: readonly CuberouterNode[] = Object.freeze([
  { id: "cn", url: "https://cuberouter.cn" },
  { id: "hk", url: "https://cuberouter.com" }
]);

/**
 * Resolves the table. The config file replaces the environment wholesale, the environment
 * replaces the shipped table, and a build that sets nothing still knows where cuberouter is.
 * Local development points one line at localhost: `MEMMY_CUBEROUTER_URLS=cn=http://127.0.0.1:3000`.
 */
export function resolveCuberouterNodes(input: {
  env: NodeJS.ProcessEnv;
  settings?: CuberouterSettings;
}): CuberouterNode[] {
  if (input.settings?.urls?.length) {
    return input.settings.urls;
  }
  const parsed = parseCuberouterNodeTable(input.env.MEMMY_CUBEROUTER_URLS ?? "");
  return parsed.length > 0 ? parsed : [...DEFAULT_CUBEROUTER_NODES];
}
