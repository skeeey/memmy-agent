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

/**
 * Resolves the table. An explicit `MEMMY_CUBEROUTER_URL` pins the build to that single node
 * (local development and the packaged test loop), and the config file replaces the environment
 * wholesale.
 */
export function resolveCuberouterNodes(input: {
  env: NodeJS.ProcessEnv;
  settings?: CuberouterSettings;
}): CuberouterNode[] {
  const pinned = input.env.MEMMY_CUBEROUTER_URL?.trim();
  if (pinned) {
    return [{ id: "default", url: pinned.replace(/\/+$/, "") }];
  }
  if (input.settings?.nodes?.length) {
    return input.settings.nodes;
  }
  return parseCuberouterNodeTable(input.env.MEMMY_CUBEROUTER_NODES ?? "");
}
