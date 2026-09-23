/** Probes the configured cuberouter nodes and picks the line to use. */
import type { CuberouterClient } from "../adapters/outbound/cuberouter-client/index.js";
import type { CuberouterNode } from "../config/cuberouter-nodes.js";

/** Samples per node: enough to survive one outlier, few enough to stay fast. */
export const PROBE_SAMPLES = 2;
export const PROBE_TIMEOUT_MS = 2000;
/** Used when nothing is reachable: the probe has no information, so no guessing happens beyond this. */
export const FALLBACK_NODE_ID = "hk";

export interface NodeProbeEntry {
  nodeId: string;
  reachable: boolean;
  latencyMs: number | null;
}

export interface NodeProbeResult {
  entries: NodeProbeEntry[];
  defaultNodeId: string | null;
}

/** Two nearby latencies are noise, so the language prior only applies inside this factor. */
const LATENCY_DECISIVE_FACTOR = 2;

/** For this build's node ids: a Chinese UI leans mainland, anything else leans Hong Kong. */
function languagePreferredNodeId(language: string): string {
  return language.toLowerCase().startsWith("zh") ? "cn" : FALLBACK_NODE_ID;
}

/** Standard median: the middle value, or the mean of the two middle values for an even count. */
export function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Picks the default line from measured results. Pure, so the rule is testable on its own. */
export function chooseDefaultNode(entries: readonly NodeProbeEntry[], language: string): string | null {
  const reachable = entries.filter((entry) => entry.reachable && entry.latencyMs !== null);
  if (reachable.length === 0) {
    return null;
  }
  if (reachable.length === 1) {
    return reachable[0]!.nodeId;
  }

  const sorted = [...reachable].sort((left, right) => left.latencyMs! - right.latencyMs!);
  const fastest = sorted[0]!;
  const slowest = sorted[sorted.length - 1]!;
  if (fastest.latencyMs! * LATENCY_DECISIVE_FACTOR <= slowest.latencyMs!) {
    return fastest.nodeId;
  }

  const preferred = languagePreferredNodeId(language);
  return reachable.some((entry) => entry.nodeId === preferred) ? preferred : fastest.nodeId;
}

export interface CuberouterNodeRouter {
  probe(): Promise<NodeProbeResult>;
  listNodes(): readonly CuberouterNode[];
  getNodeUrl(nodeId: string): string | null;
  getPreferredNodeId(): Promise<string | null>;
  setPreferredNodeId(nodeId: string): Promise<void>;
}

export interface CreateCuberouterNodeRouterOptions {
  nodes: readonly CuberouterNode[];
  clientFor: (url: string) => CuberouterClient;
  readPreferredNodeId: () => Promise<string | null>;
  writePreferredNodeId: (nodeId: string) => Promise<void>;
  language: () => string;
  log: (message: string) => void;
  now?: () => number;
}

export function createCuberouterNodeRouter(options: CreateCuberouterNodeRouterOptions): CuberouterNodeRouter {
  const now = options.now ?? Date.now;

  async function measure(node: CuberouterNode): Promise<NodeProbeEntry> {
    const samples: number[] = [];
    const client = options.clientFor(node.url);
    for (let attempt = 0; attempt < PROBE_SAMPLES; attempt += 1) {
      const startedAt = now();
      try {
        const status = await client.getRegistrationRequirements({ timeoutMs: PROBE_TIMEOUT_MS });
        samples.push(now() - startedAt);
        // Soft check: the node names itself. A mismatch means something rewrote the route; it never blocks.
        if (status.serverAddress && !node.url.startsWith(status.serverAddress.replace(/\/+$/, ""))) {
          options.log(`[cuberouter] node ${node.id} answers for ${status.serverAddress} (configured ${node.url})`);
        }
      } catch (error) {
        options.log(
          `[cuberouter] probe ${node.id} (${node.url}) failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (samples.length === 0) {
      return { nodeId: node.id, reachable: false, latencyMs: null };
    }
    const latencyMs = median(samples);
    options.log(`[cuberouter] probe ${node.id} (${node.url}) reachable in ${latencyMs}ms`);
    return { nodeId: node.id, reachable: true, latencyMs };
  }

  return {
    async probe() {
      // A single node has nothing to choose between, so no probe traffic is sent at all: this
      // is the pinned-URL case and single-node builds, where the choice is already made.
      if (options.nodes.length <= 1) {
        return { entries: [], defaultNodeId: options.nodes[0]?.id ?? null };
      }

      const entries = await Promise.all(options.nodes.map((node) => measure(node)));
      const defaultNodeId = chooseDefaultNode(entries, options.language());
      options.log(
        `[cuberouter] probe result: ${
          entries.map((entry) => `${entry.nodeId}=${entry.reachable ? `${entry.latencyMs}ms` : "unreachable"}`).join(", ")
        } → default ${defaultNodeId ?? FALLBACK_NODE_ID}`
      );
      return { entries, defaultNodeId };
    },

    listNodes() {
      return options.nodes;
    },

    getNodeUrl(nodeId) {
      return options.nodes.find((node) => node.id === nodeId)?.url ?? null;
    },

    async getPreferredNodeId() {
      return await options.readPreferredNodeId();
    },

    async setPreferredNodeId(nodeId) {
      await options.writePreferredNodeId(nodeId);
    }
  };
}
