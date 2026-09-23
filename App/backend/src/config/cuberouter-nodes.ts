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
 * wholesale. Nothing configured at all falls back to the resolved default URL, so a build
 * without a table behaves exactly as every build did before the table existed.
 */
export function resolveCuberouterNodes(input: {
  env: NodeJS.ProcessEnv;
  settings?: CuberouterSettings;
  /** Already-resolved default line (env > config.yaml > localhost). */
  defaultUrl: string;
}): CuberouterNode[] {
  const pinned = input.env.MEMMY_CUBEROUTER_URL?.trim();
  if (pinned) {
    return [{ id: "default", url: normalizeUrl(pinned) }];
  }
  if (input.settings?.nodes?.length) {
    return input.settings.nodes;
  }
  const parsed = parseCuberouterNodeTable(input.env.MEMMY_CUBEROUTER_NODES ?? "");
  if (parsed.length > 0) {
    return parsed;
  }
  return [{ id: "default", url: normalizeUrl(input.defaultUrl) }];
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
