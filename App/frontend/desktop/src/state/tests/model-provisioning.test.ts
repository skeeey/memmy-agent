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

/**
 * Server stub that remembers what was written and hands it back on the next read, the way the
 * local API does — including never echoing a stored secret (`apiKey: ""` on endpoints).
 */
function configClientServer() {
  const saved: any[] = [];
  let catalog = createModelWorkspace(null).catalog;
  const client = {
    getModelConfig: vi.fn(async () => ({
      catalog,
      configRevision: catalog.configRevision,
      provider: "openai",
      endpoint: "",
      model: "",
      apiKey: "",
      apiKeyMasked: "",
      configured: true
    })),
    saveModelCatalog: vi.fn(async (input: any) => {
      saved.push(input);
      catalog = catalogFromWrite(input, saved.length);
      return {
        catalog,
        configRevision: catalog.configRevision,
        provider: "openai",
        endpoint: "",
        model: "",
        apiKey: "",
        apiKeyMasked: "",
        configured: true
      };
    })
  };
  return { client: client as any, saved };
}

/** Mirrors the server's catalog view after a write: stored secrets are never echoed back. */
function catalogFromWrite(input: any, revision: number) {
  return {
    ...createModelWorkspace(null).catalog,
    configRevision: `rev-${revision}`,
    providers: input.providers.map((provider: any) => ({
      provider: provider.provider,
      configured: true,
      hasApiKey: true,
      apiKeyMasked: "",
      apiKey: "",
      accountManaged: false,
      editable: true,
      endpoints: provider.endpoints.map((endpoint: any) => ({
        endpointId: endpoint.endpointId,
        apiBase: endpoint.apiBase,
        protocol: endpoint.protocol,
        hasApiKey: true,
        apiKeyMasked: "",
        apiKey: ""
      })),
      models: provider.models.map((model: any) => ({
        presetId: model.presetId,
        provider: provider.provider,
        endpointId: model.endpointId,
        protocol: provider.endpoints.find((endpoint: any) => endpoint.endpointId === model.endpointId)?.protocol
          ?? "openai-chat-completions",
        model: model.model,
        source: model.source,
        capabilities: [...model.capabilities],
        available: true
      }))
    })),
    modelAssignments: structuredClone(input.modelAssignments),
    configured: true
  };
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

  it("re-provisions one endpoint and one preset when a previous login already wrote them", async () => {
    const server = configClientServer();
    const input = {
      configClient: server.client,
      endpoint: { apiBase: "http://127.0.0.1:3000/v1", protocol: "openai-chat-completions" as const, apiKey: "sk-plain" },
      model: "deepseek-flash",
      capabilities: ["agent", "memory_summary", "memory_evolution"] as const,
      assign: ["agent", "memory_summary", "memory_evolution"] as const
    };

    await provisionByokModel({ ...input, capabilities: [...input.capabilities], assign: [...input.assign] });
    await provisionByokModel({ ...input, capabilities: [...input.capabilities], assign: [...input.assign] });

    expect(server.saved).toHaveLength(2);
    const [first, second] = server.saved;
    expect(first.providers).toHaveLength(1);
    expect(second.providers).toHaveLength(1);
    expect(second.providers[0].endpoints).toHaveLength(1);
    expect(second.providers[0].models).toHaveLength(1);
    expect(second.providers[0].endpoints[0].endpointId)
      .toBe(first.providers[0].endpoints[0].endpointId);
    expect(second.providers[0].models[0].presetId)
      .toBe(first.providers[0].models[0].presetId);
    // The server never echoes the stored secret, so every write must carry it again.
    expect(second.providers[0].endpoints[0].apiKey).toBe("sk-plain");
    expect(second.modelAssignments.byok.agent.default).toBe(second.providers[0].models[0].presetId);
  });
});
