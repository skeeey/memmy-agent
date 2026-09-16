/** Model provisioning module. */
import type { ModelCapability, ModelEndpointProtocol } from "@memmy/local-api-contracts";
import type { ConfigClient } from "../api/config-client.js";
import {
  assignCatalogPreset,
  createModelWorkspace,
  modelConfigInput,
  upsertByokPreset
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
 * @param input the endpoint, model, capabilities and assignment slots.
 */
export async function provisionByokModel(input: ProvisionByokModelInput): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await input.configClient.getModelConfig();
    let workspace = createModelWorkspace(latest);
    const preset = upsertByokPreset(workspace, {
      provider: PROVIDER_ID,
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
      await input.configClient.saveModelCatalog(modelConfigInput(workspace));
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (attempt === 1 || (code !== "model_config_changed" && code !== "config_write_busy")) {
        throw error;
      }
    }
  }
}
