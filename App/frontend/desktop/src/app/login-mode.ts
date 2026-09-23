/** Login mode module. */
import type { AppSettingsDto, OnboardingStateDto } from "@memmy/local-api-contracts";
import type { Dispatch } from "react";
import type { ConfigClient } from "../api/config-client.js";
import { appActions, type AppAction } from "../state/app-actions.js";

/** Contract for persist login mode selection input. */
export interface PersistLoginModeSelectionInput {
  configClient?: Pick<ConfigClient, "updateSettings" | "updateOnboarding" | "getModelConfig">
    & Partial<Pick<ConfigClient, "getTokenUsage">>;
  dispatch: Dispatch<AppAction>;
  userMode: Extract<AppSettingsDto["userMode"], "account" | "byok">;
  onboarding?: Partial<OnboardingStateDto>;
}

/** Contract for persist login mode selection result. */
export interface PersistLoginModeSelectionResult {
  /**
   * The onboarding state as the backend read it back after the mode was saved. Callers that
   * route must prefer this over any value captured before the login: the pre-login snapshot
   * may have been read in a different scope than the one this login writes into.
   */
  onboarding?: Partial<OnboardingStateDto>;
}

/** Handles persist login mode selection. */
export async function persistLoginModeSelection(
  input: PersistLoginModeSelectionInput
): Promise<PersistLoginModeSelectionResult> {
  const settingsPatch = { userMode: input.userMode };
  const savedSettings = await saveSettingsPatch(input.configClient, settingsPatch);
  const modelConfig = input.userMode === "account"
    ? await requireCanonicalModelConfig(input.configClient)
    : null;

  if (input.userMode === "account" && input.configClient?.getTokenUsage) {
    try {
      const tokenUsage = await input.configClient.getTokenUsage();
      input.dispatch(appActions.tokenUsageUpdated(tokenUsage));
    } catch (error) {
      // Quota synchronization failure must not block login. The unsynchronized
      // placeholder has lastSyncedAt=null, so it cannot trigger the exhausted modal.
      console.warn("refresh token usage after login failed", error);
    }
  }

  input.dispatch(appActions.settingsUpdated(savedSettings));
  if (modelConfig) input.dispatch(appActions.modelConfigUpdated(modelConfig));

  if (!input.onboarding) {
    return {};
  }

  const savedOnboarding = await saveOnboardingPatch(input.configClient, input.onboarding);
  input.dispatch(appActions.onboardingUpdated(savedOnboarding));
  return { onboarding: savedOnboarding };
}

/** Loads the post-login canonical model catalog required before account-mode rendering. */
async function requireCanonicalModelConfig(
  configClient: PersistLoginModeSelectionInput["configClient"]
) {
  if (!configClient) throw new Error("Config client is unavailable after account login");
  return configClient.getModelConfig();
}

/** Writes save settings patch. */
async function saveSettingsPatch(
  configClient: PersistLoginModeSelectionInput["configClient"],
  settingsPatch: Partial<AppSettingsDto>
): Promise<Partial<AppSettingsDto>> {
  if (!configClient) {
    return settingsPatch;
  }

  return configClient.updateSettings(settingsPatch);
}

/** Writes save onboarding patch. */
async function saveOnboardingPatch(
  configClient: PersistLoginModeSelectionInput["configClient"],
  onboardingPatch: Partial<OnboardingStateDto>
): Promise<Partial<OnboardingStateDto>> {
  if (!configClient) {
    return onboardingPatch;
  }

  return configClient.updateOnboarding(onboardingPatch);
}
