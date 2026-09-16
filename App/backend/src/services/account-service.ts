/** Account service module. */
import {
  AccountInvitationViewSchema,
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  type AccountInvitationView,
  type AccountProfileView,
  type AccountSessionView,
  type UpdateAccountProfileInput
} from "@memmy/local-api-contracts";
import type { CloudAccountProfile, CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type {
  AccountSessionProfileInput,
  AccountSessionRepository
} from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { MemmyConfigWriter, RuntimeProjectionResult } from "../infrastructure/memmy-config/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { OkResponse } from "@memmy/local-api-contracts";

export interface AccountService {
  getInvitation(): Promise<AccountInvitationView>;
  updateProfile(input: UpdateAccountProfileInput): Promise<AccountProfileView>;
  markGuideFinished(): Promise<OkResponse>;
  logout(): Promise<OkResponse>;
  getSession(): Promise<AccountSessionView>;
}

export interface CreateAccountServiceOptions {
  /** Cloud client. */
  cloudClient: CloudClient;
  /** Account session repository. */
  accountSessionRepository: AccountSessionRepository;
  /** Bootstrap repository used to preserve machine-level onboarding across logout. */
  bootstrapRepository: Pick<BootstrapRepository, "preserveCompletedOnboardingForLocalByok">;
  /** Memmy config writer. */
  memmyConfigWriter?: MemmyConfigWriter;
  /** Memory client. */
  memoryClient?: Pick<MemoryClient, "reloadConfig">;
}

/** Creates create account service. */
export function createAccountService(options: CreateAccountServiceOptions): AccountService {
  // A cuberouter session stores the cuberouter JWT as its cloud credential, so every
  // memmy-cloud call that would send it as a bearer has to be skipped: the cloud answers
  // 401, and the guide refresh then wipes the session on each restart.
  function isCuberouterSession(): boolean {
    return options.accountSessionRepository.getAuthChannel() === "cuberouter";
  }

  return {
    async getInvitation() {
      if (isCuberouterSession()) {
        return AccountInvitationViewSchema.parse({
          enabled: false,
          invitationCode: null,
          usedInviteSlotsToday: 0,
          dailySuccessLimit: 0,
          remainingInvitesToday: 0,
          dailyLimitReached: false
        });
      }

      const cloudUuid = options.accountSessionRepository.getCloudUuid();
      if (!cloudUuid) {
        throw Object.assign(new Error("Account session is not authenticated"), {
          code: "unauthorized" as const
        });
      }
      return AccountInvitationViewSchema.parse(
        await options.cloudClient.ensureInvitationCode({ uuid: cloudUuid })
      );
    },

    async updateProfile(input) {
      const session = options.accountSessionRepository.get();
      if (!session.authenticated) {
        throw Object.assign(new Error("Account session is not authenticated"), { code: "unauthorized" as const });
      }

      const cloudUuid = options.accountSessionRepository.getCloudUuid();
      if (cloudUuid && !isCuberouterSession()) {
        await options.cloudClient.updateAccountProfile({ uuid: cloudUuid, userName: input.nickname });
      }

      const updated = options.accountSessionRepository.upsert({
        profile: {
          ...session.profile,
          nickname: input.nickname,
          rawProfile: {
            ...session.profile,
            userName: input.nickname
          }
        }
      });

      if (!updated.authenticated) {
        throw Object.assign(new Error("Account session is not authenticated"), { code: "unauthorized" as const });
      }

      return AccountProfileViewSchema.parse(updated.profile);
    },

    async markGuideFinished() {
      if (isCuberouterSession()) {
        return { ok: true };
      }

      const uuid = options.accountSessionRepository.getCloudUuid();
      if (uuid) {
        await options.cloudClient.updateAccountGuide({ uuid, hasFinishedGuide: true });
      }

      return { ok: true };
    },

    async logout() {
      const uuid = options.accountSessionRepository.getCloudUuid();
      const session = options.accountSessionRepository.get();
      options.bootstrapRepository.preserveCompletedOnboardingForLocalByok();
      if (uuid && !isCuberouterSession()) {
        try {
          await options.cloudClient.logout({ uuid });
        } catch {
          // noop
        }
      }

      await clearLocalAccountState(
        options,
        session.authenticated ? session.profile.userId : undefined,
        true,
        uuid ?? undefined
      );
      return { ok: true };
    },

    async getSession() {
      const session = AccountSessionViewSchema.parse(options.accountSessionRepository.get());
      if (isCuberouterSession()) {
        return session;
      }

      const cloudUuid = session.authenticated ? options.accountSessionRepository.getCloudUuid() : null;
      return refreshCloudGuideState({
        cloudClient: options.cloudClient,
        accountSessionRepository: options.accountSessionRepository,
        session,
        cloudUuid: cloudUuid ?? undefined,
        onAuthenticationInvalid: () => clearLocalAccountState(
          options,
          session.authenticated ? session.profile.userId : undefined,
          false,
          cloudUuid ?? undefined
        )
      });
    }
  };
}

async function reloadMemoryConfigIfNeeded(
  projection: RuntimeProjectionResult | undefined,
  options: CreateAccountServiceOptions
): Promise<void> {
  if (!projection?.changed || !projection.memoryConfigAffected || !options.memoryClient) {
    return;
  }

  try {
    await options.memoryClient.reloadConfig({ reason: "account_profile_projected" });
  } catch {
    // noop
  }
}

async function clearLocalAccountState(
  options: CreateAccountServiceOptions,
  ownerAccountId?: string,
  syncSelectedByokToLocal = false,
  expectedCloudUuid?: string
): Promise<void> {
  const projection = await options.memmyConfigWriter?.clearAccountModelProjection?.({
    ownerAccountId,
    syncSelectedByokToLocal,
    expectedCloudUuid
  });
  if (expectedCloudUuid) {
    options.accountSessionRepository.clearIfCloudUuid(expectedCloudUuid);
  } else {
    options.accountSessionRepository.clear();
  }
  await reloadMemoryConfigIfNeeded(projection, options);
}

/** Handles refresh cloud guide state. */
async function refreshCloudGuideState(input: {
  cloudClient: CloudClient;
  accountSessionRepository: AccountSessionRepository;
  session: AccountSessionView;
  cloudUuid?: string;
  onAuthenticationInvalid?: () => Promise<void>;
}): Promise<AccountSessionView> {
  if (!input.session.authenticated) {
    return input.session;
  }

  const cloudUuid = input.cloudUuid ?? input.accountSessionRepository.getCloudUuid();
  if (!cloudUuid) {
    return input.session;
  }

  let cloudProfile: CloudAccountProfile;
  try {
    cloudProfile = await input.cloudClient.getAccountInfo({ uuid: cloudUuid });
  } catch (error) {
    if (isUnauthorized(error) && input.onAuthenticationInvalid) {
      await input.onAuthenticationInvalid();
    }
    throw error;
  }
  return AccountSessionViewSchema.parse(
    input.accountSessionRepository.upsert({
      profile: toSessionProfileInput(cloudProfile),
      isNewUser: input.session.isNewUser
    })
  );
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "unauthorized");
}

/**
 * Converts a cloud-client profile into account session repository input.
 *
 * @param profile Account profile returned by the cloud-client.
 * @returns A profile that accountSessionRepo can persist.
 */
function toSessionProfileInput(profile: CloudAccountProfile): AccountSessionProfileInput {
  return {
    userId: profile.userId,
    email: profile.email,
    phoneNumber: profile.phoneNumber,
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    planType: profile.planType,
    hasFinishedGuide: profile.hasFinishedGuide,
    region: profile.region,
    registeredAt: profile.registeredAt,
    // Cloud profiles always come from the memmy_cloud identity provider.
    identityProvider: "memmy_cloud",
    rawProfile: profile.rawProfile
  };
}
