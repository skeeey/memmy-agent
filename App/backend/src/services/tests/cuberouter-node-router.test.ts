/** Cuberouter node router tests. */
import { describe, expect, it, vi } from "vitest";
import {
  chooseDefaultNode,
  createCuberouterNodeRouter,
  median,
  type NodeProbeEntry
} from "../cuberouter-node-router.js";

const entry = (nodeId: string, latencyMs: number | null): NodeProbeEntry => ({
  nodeId,
  reachable: latencyMs !== null,
  latencyMs
});

const nodes = [
  { id: "cn", url: "https://cn.example" },
  { id: "hk", url: "https://hk.example" }
];

/**
 * Builds a router whose fake clients advance a clock by each call's configured latency, so
 * measurements are exact and the "which node is faster" assertion cannot flake on timers.
 */
function createProbeHarness(input: {
  latencies?: Record<string, number[]>;
  failUrls?: string[];
  language?: string;
  nodes?: Array<{ id: string; url: string }>;
}) {
  const latencies = input.latencies ?? { "https://cn.example": [300, 100], "https://hk.example": [500, 700] };
  const failUrls = input.failUrls ?? [];
  let clock = 0;
  const log = vi.fn();
  const clientFor = vi.fn((url: string) => ({
    getRegistrationRequirements: async () => {
      // The two nodes are probed concurrently, so the clock may only advance when a call
      // completes — and monotonically, or one node's latency would be counted into the other's.
      const startedAt = clock;
      await Promise.resolve();
      if (failUrls.includes(url)) {
        throw Object.assign(new Error("rejected"), { code: "rejected" });
      }
      clock = Math.max(clock, startedAt + (latencies[url]?.shift() ?? 0));
      return { emailVerificationRequired: false, turnstileRequired: false, serverAddress: url };
    }
  }));
  const router = createCuberouterNodeRouter({
    nodes: input.nodes ?? nodes,
    clientFor: clientFor as never,
    readPreferredNodeId: async () => null,
    writePreferredNodeId: async () => undefined,
    language: () => input.language ?? "en-US",
    log,
    now: () => clock
  });
  return { router, clientFor, log };
}

describe("chooseDefaultNode", () => {
  it("uses the only reachable node, whatever the latency", () => {
    expect(chooseDefaultNode([entry("cn", 120), entry("hk", null)], "en-US")).toBe("cn");
  });

  it("takes the clearly faster node when the gap is at least 2x", () => {
    expect(chooseDefaultNode([entry("cn", 120), entry("hk", 480)], "en-US")).toBe("cn");
    expect(chooseDefaultNode([entry("cn", 500), entry("hk", 130)], "zh-CN")).toBe("hk");
  });

  it("falls back to the language when the gap is under 2x", () => {
    expect(chooseDefaultNode([entry("cn", 200), entry("hk", 300)], "zh-CN")).toBe("cn");
    expect(chooseDefaultNode([entry("cn", 200), entry("hk", 300)], "en-US")).toBe("hk");
  });

  it("returns null when nothing is reachable", () => {
    expect(chooseDefaultNode([entry("cn", null), entry("hk", null)], "zh-CN")).toBeNull();
    expect(chooseDefaultNode([], "zh-CN")).toBeNull();
  });
});

describe("median", () => {
  it("takes the middle value, and the mean of the two middle values for an even count", () => {
    expect(median([300])).toBe(300);
    expect(median([300, 100])).toBe(200);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([10, 2, 8, 4])).toBe(6);
  });
});

describe("cuberouter node router", () => {
  it("probes every node twice and logs what it saw", async () => {
    // The two probes overlap in time, so a shared test clock cannot attribute latencies
    // reliably; the exact medians are asserted in the single-node-reachable case below and in
    // the pure `median`/`chooseDefaultNode` tests. Here the mechanics are what matters.
    const { router, clientFor, log } = createProbeHarness({});

    const result = await router.probe();

    expect(clientFor).toHaveBeenCalledTimes(2);
    expect(result.entries).toEqual([
      { nodeId: "cn", reachable: true, latencyMs: expect.any(Number) },
      { nodeId: "hk", reachable: true, latencyMs: expect.any(Number) }
    ]);
    expect(["cn", "hk"]).toContain(result.defaultNodeId);
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("cn");
    expect(logged).toContain("hk");
  });

  it("medians the samples of the only reachable node and picks it", async () => {
    const { router } = createProbeHarness({ failUrls: ["https://cn.example"], language: "zh-CN" });

    const result = await router.probe();

    // Only hk moves the clock, so its samples (500/700) are exact here.
    expect(result.entries).toEqual([
      { nodeId: "cn", reachable: false, latencyMs: null },
      { nodeId: "hk", reachable: true, latencyMs: 600 }
    ]);
    expect(result.defaultNodeId).toBe("hk");
  });

  it("resolves a node url and rejects an unknown id", () => {
    const { router } = createProbeHarness({});

    expect(router.getNodeUrl("hk")).toBe("https://hk.example");
    expect(router.getNodeUrl("nope")).toBeNull();
    expect(router.listNodes().map((node) => node.id)).toEqual(["cn", "hk"]);
  });

  it("sends no probe traffic when there is only one node (pinned URL or single-node build)", async () => {
    const { router, clientFor } = createProbeHarness({
      nodes: [{ id: "default", url: "http://127.0.0.1:3000" }]
    });

    const result = await router.probe();

    expect(clientFor).not.toHaveBeenCalled();
    expect(result.defaultNodeId).toBe("default");
  });
});
