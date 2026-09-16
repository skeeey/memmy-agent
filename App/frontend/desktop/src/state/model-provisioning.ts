/** Model provisioning module. */
import type { ModelCapability, ModelEndpointProtocol } from "@memmy/local-api-contracts";
import type { ConfigClient, ModelProviderConfig } from "../api/config-client.js";
import {
  assignCatalogPreset,
  createModelWorkspace,
  modelConfigInput,
  upsertByokPreset,
  type ModelWorkspace
} from "./model-workspace.js";

const PROVIDER_ID = "openai";

/** Contract for provision byok model input. */
export interface ProvisionByokModelInput {
  configClient: ConfigClient;
  endpoint: { apiBase: string; protocol: ModelEndpointProtocol; apiKey: string };
  model: string;
  /** Capabilities written into the preset. */
  capabilities: ModelCapability[];
  /** Assignment slots pointed at the preset. */
  assign: ModelCapability[];
}

/**
 * Writes one BYOK provider/endpoint/preset for the given key and model, then
 * points the requested assignment slots at it.
 *
 * Re-running it is a no-op beyond refreshing the stored secret: the existing
 * endpoint is looked up by its normalised apiBase and protocol first, because
 * `upsertByokPreset` cannot recognise it on its own — the server never echoes a
 * stored key, so a plain-key comparison never matches and a second login would
 * push a duplicate endpoint that the API rejects.
 *
 * @param input the endpoint, model, capabilities and assignment slots.
 * @returns the saved catalog, so callers do not need to read it back.
 */
export async function provisionByokModel(input: ProvisionByokModelInput): Promise<ModelProviderConfig> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await input.configClient.getModelConfig();
    let workspace = createModelWorkspace(latest);
    const existingEndpointId = findExistingEndpointId(workspace, input.endpoint);
    const preset = upsertByokPreset(workspace, {
      provider: PROVIDER_ID,
      ...(existingEndpointId ? { endpointId: existingEndpointId } : {}),
      endpoint: input.endpoint.apiBase,
      protocol: input.endpoint.protocol,
      apiKey: input.endpoint.apiKey,
      model: input.model,
      capabilities: input.capabilities
    });
    workspace = preset.workspace;
    for (const capability of input.assign) {
      workspace = assignCatalogPreset(workspace, "byok", capability, preset.presetId);
    }

    try {
      return await input.configClient.saveModelCatalog(modelConfigInput(workspace));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (attempt === 1 || (code !== "model_config_changed" && code !== "config_write_busy")) {
        throw error;
      }
    }
  }

  throw new Error("unreachable: provisionByokModel retried without resolving");
}

/** Finds an existing BYOK endpoint with the same normalised apiBase and protocol. */
function findExistingEndpointId(
  workspace: ModelWorkspace,
  endpoint: ProvisionByokModelInput["endpoint"]
): string | undefined {
  const apiBase = endpoint.apiBase.trim().replace(/\/+$/, "");
  const provider = workspace.catalog.providers.find(
    (item) => item.provider === PROVIDER_ID && !item.accountManaged
  );
  return provider?.endpoints.find(
    (item) => item.apiBase.replace(/\/+$/, "") === apiBase && item.protocol === endpoint.protocol
  )?.endpointId;
}
