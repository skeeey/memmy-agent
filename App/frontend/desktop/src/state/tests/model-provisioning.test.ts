/** Model provisioning tests. */
import { describe, expect, it, vi } from "vitest";
import { createModelWorkspace } from "../model-workspace.js";
import { provisionByokModel } from "../model-provisioning.js";

function configClientWithCalls() {
  const saved: any[] = [];
  const client = {
    getModelConfig: vi.fn(async () => ({
      providers: [],
      modelAssignments: createModelWorkspace(null).catalog.modelAssignments,
      configRevision: "rev-1"
    })),
    saveModelCatalog: vi.fn(async (input: any) => {
      saved.push(input);
      return { providers: [], modelAssignments: input.modelAssignments, configRevision: "rev-2" };
    })
  };
  return { client: client as any, saved };
}

describe("provisionByokModel", () => {
  it("writes one openai provider with the cuberouter endpoint and assigns three capabilities", async () => {
    const { client, saved } = configClientWithCalls();

    await provisionByokModel({
      configClient: client,
      endpoint: { apiBase: "http://127.0.0.1:3000/v1", protocol: "openai-chat-completions", apiKey: "sk-plain" },
      model: "deepseek-flash",
      capabilities: ["agent", "memory_summary", "memory_evolution"],
      assign: ["agent", "memory_summary", "memory_evolution"]
    });

    expect(saved).toHaveLength(1);
    const provider = saved[0].providers.find((item: any) => item.provider === "openai");
    expect(provider.endpoints[0].apiBase).toBe("http://127.0.0.1:3000/v1");
    expect(provider.endpoints[0].apiKey).toBe("sk-plain");
    expect(provider.models[0].model).toBe("deepseek-flash");
    expect(provider.models[0].capabilities).toEqual(
      expect.arrayContaining(["agent", "memory_summary", "memory_evolution"])
    );
    const byok = saved[0].modelAssignments.byok;
    const presetId = provider.models[0].presetId;
    expect(byok.agent.default).toBe(presetId);
    expect(byok.agent.candidates).toContain(presetId);
    expect(byok.memorySummary).toBe(presetId);
    expect(byok.memoryEvolution).toBe(presetId);
    expect(byok.embedding).toBeNull();
  });

  it("retries once when the catalog revision is stale", async () => {
    const { client, saved } = configClientWithCalls();
    client.saveModelCatalog.mockRejectedValueOnce(
      Object.assign(new Error("stale"), { code: "model_config_changed" })
    );

    await provisionByokModel({
      configClient: client,
      endpoint: { apiBase: "http://127.0.0.1:3000/v1", protocol: "openai-chat-completions", apiKey: "sk-plain" },
      model: "deepseek-flash",
      capabilities: ["agent", "memory_summary", "memory_evolution"],
      assign: ["agent", "memory_summary", "memory_evolution"]
    });

    expect(client.saveModelCatalog).toHaveBeenCalledTimes(2);
    expect(saved).toHaveLength(1);
  });
});
