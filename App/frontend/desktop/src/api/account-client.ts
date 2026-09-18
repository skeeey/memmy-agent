import {
  AccountInvitationViewSchema,
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  CuberouterAuthInputSchema,
  CuberouterAuthResultSchema,
  CuberouterEmailCodeInputSchema,
  CuberouterRegistrationRequirementsSchema,
  OkResponseSchema,
  UpdateAccountProfileInputSchema,
  type AccountInvitationView,
  type AccountProfileView,
  type AccountSessionView,
  type CuberouterAuthInput,
  type CuberouterAuthResult,
  type CuberouterEmailCodeInput,
  type CuberouterRegistrationRequirements,
  type OkResponse,
  type RuntimeConfig,
  type UpdateAccountProfileInput
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface AccountClient {
  register(input: CuberouterAuthInput): Promise<CuberouterAuthResult>;
  login(input: CuberouterAuthInput): Promise<CuberouterAuthResult>;
  /** Asks the instance what its registration form must collect. */
  getRegistrationRequirements(): Promise<CuberouterRegistrationRequirements>;
  sendEmailVerificationCode(input: CuberouterEmailCodeInput): Promise<OkResponse>;
  getInvitation(): Promise<AccountInvitationView>;
  updateProfile(input: UpdateAccountProfileInput): Promise<AccountProfileView>;
  markGuideFinished(): Promise<OkResponse>;
  logout(): Promise<OkResponse>;
  getSession(): Promise<AccountSessionView>;
}

export function createHttpAccountClient(config: RuntimeConfig): AccountClient {
  return {
    async register(input) {
      return requestJson({
        config,
        path: "/api/account/register",
        schema: CuberouterAuthResultSchema,
        body: CuberouterAuthInputSchema.parse(input)
      });
    },

    async login(input) {
      return requestJson({
        config,
        path: "/api/account/login",
        schema: CuberouterAuthResultSchema,
        body: CuberouterAuthInputSchema.parse(input)
      });
    },

    async getRegistrationRequirements() {
      return requestJson({
        config,
        path: "/api/account/registration-requirements",
        schema: CuberouterRegistrationRequirementsSchema,
        init: { method: "GET" }
      });
    },

    async sendEmailVerificationCode(input) {
      return requestJson({
        config,
        path: "/api/account/email-code",
        schema: OkResponseSchema,
        init: { method: "POST" },
        body: CuberouterEmailCodeInputSchema.parse(input)
      });
    },

    async getInvitation() {
      return requestJson({
        config,
        path: "/api/account/invitation",
        schema: AccountInvitationViewSchema,
        init: { method: "PUT" }
      });
    },

    async updateProfile(input) {
      return requestJson({
        config,
        path: "/api/account/profile",
        schema: AccountProfileViewSchema,
        init: { method: "PATCH" },
        body: UpdateAccountProfileInputSchema.parse(input)
      });
    },

    async markGuideFinished() {
      return requestJson({
        config,
        path: "/api/account/guide-finished",
        schema: OkResponseSchema,
        init: { method: "POST" },
        body: {}
      });
    },

    async logout() {
      return requestJson({
        config,
        path: "/api/account/logout",
        schema: OkResponseSchema,
        init: { method: "POST" },
        body: {}
      });
    },

    async getSession() {
      return requestJson({
        config,
        path: "/api/account/session",
        schema: AccountSessionViewSchema
      });
    }
  };
}
