import {
  AccountInvitationViewSchema,
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  CuberouterAuthInputSchema,
  CuberouterAuthResultSchema,
  CuberouterEmailCodeInputSchema,
  CuberouterNodeProbeViewSchema,
  CuberouterNodesViewSchema,
  CuberouterRegistrationRequirementsSchema,
  OkResponseSchema,
  UpdateAccountProfileInputSchema,
  type AccountInvitationView,
  type AccountProfileView,
  type AccountSessionView,
  type CuberouterAuthInput,
  type CuberouterAuthResult,
  type CuberouterEmailCodeInput,
  type CuberouterNodeProbeView,
  type CuberouterNodesView,
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
  getRegistrationRequirements(nodeId?: string): Promise<CuberouterRegistrationRequirements>;
  /** The configured lines and the one currently in effect. */
  getNodes(): Promise<CuberouterNodesView>;
  /** Measures every line; slow (up to ~4s), so call it on mount only. */
  probeNodes(): Promise<CuberouterNodeProbeView>;
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

    async getRegistrationRequirements(nodeId) {
      const query = nodeId ? `?${new URLSearchParams({ nodeId }).toString()}` : "";
      return requestJson({
        config,
        path: `/api/account/registration-requirements${query}`,
        schema: CuberouterRegistrationRequirementsSchema,
        init: { method: "GET" }
      });
    },

    async getNodes() {
      return requestJson({
        config,
        path: "/api/account/nodes",
        schema: CuberouterNodesViewSchema,
        init: { method: "GET" }
      });
    },

    async probeNodes() {
      return requestJson({
        config,
        path: "/api/account/nodes/probe",
        schema: CuberouterNodeProbeViewSchema,
        init: { method: "POST" }
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
