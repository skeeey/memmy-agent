import type { InvitationResult } from "@memmy/local-api-contracts";
import type {
  AnalyticsEvent,
  InviteCodeCopiedEvent,
  InviteResultToastEvent,
  SignupCompletedEvent
} from "../analytics/analytics-events.js";

export type TrackAnalyticsEvent = (event: AnalyticsEvent) => void;

export interface InvitationSignupEventInput {
  /** How the account was created: a contact channel, or the cuberouter register/login flow. */
  channel: "email" | "phone" | "cuberouter";
  isNewUser: boolean;
  /** The user mode this signup lands on; the cuberouter panel always selects BYOK. */
  userMode: "account" | "byok";
  invitationCode?: string;
}

/** Builds the shared signup event without exposing the invitation code. */
export function buildInvitationSignupEvent(
  input: InvitationSignupEventInput
): SignupCompletedEvent {
  return {
    name: "signup_completed",
    params: {
      method: input.channel,
      is_new_user: input.isNewUser,
      user_mode: input.userMode,
      invite_code_provided: Boolean(input.invitationCode?.trim())
    },
    consentTier: "basic"
  };
}

/** Builds an analytics event only for invitation outcomes that render a Toast. */
export function buildInvitationToastEvent(
  status: InvitationResult["status"]
): InviteResultToastEvent | null {
  if (status !== "success" && status !== "invalid" && status !== "not_new_user") {
    return null;
  }

  return {
    name: "invite_result_toast",
    params: { result: status },
    consentTier: "basic"
  };
}

export interface CopyInvitationCodeInput {
  invitationCode: string;
  clipboard: Pick<Clipboard, "writeText">;
  track: TrackAnalyticsEvent;
}

/** Copies an invitation code and reports success only after the Clipboard API resolves. */
export async function copyInvitationCode(input: CopyInvitationCodeInput): Promise<void> {
  await input.clipboard.writeText(input.invitationCode);
  const event: InviteCodeCopiedEvent = {
    name: "invite_code_copied",
    params: { page_path: "/settings" },
    consentTier: "basic"
  };
  input.track(event);
}
