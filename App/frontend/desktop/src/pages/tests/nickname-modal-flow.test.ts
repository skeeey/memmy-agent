/** Nickname modal flow tests. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const authPanelPath = resolve(__dirname, "../../components/account-auth-panel.tsx");
const tokenDetailPagePath = resolve(__dirname, "../token-detail-page.tsx");

// The welcome, login and token-detail pages all delegate registration to the shared
// AccountAuthPanel, so the post-registration continuation they used to own lives there.
const accountRegistrationEntries = [
  { path: authPanelPath, continueCall: "await continueAfterAuth(result);" }
];

const accountEntrySources = [
  authPanelPath,
  resolve(__dirname, "../login-page.tsx"),
  resolve(__dirname, "../welcome-page.tsx"),
  tokenDetailPagePath
];

describe("nickname modal flow", () => {
  it("三个注册入口注册成功后直接进入扫描授权引导，昵称不在注册时收集", () => {
    for (const { path, continueCall } of accountRegistrationEntries) {
      const pageSource = readSource(path);

      expect(pageSource).toContain(continueCall);
      // The new-user registration branch no longer opens the nickname modal during registration, to avoid pushing the nickname ahead of the scan authorization step.
      expect(pageSource).not.toContain('dispatch(appActions.modalChanged("nickname", true));');
    }
  });

  it("注册入口不再残留昵称弹窗死代码", () => {
    for (const path of accountEntrySources) {
      const pageSource = readSource(path);

      expect(pageSource).not.toContain("<NicknameModal");
      expect(pageSource).not.toContain('from "../components/nickname-modal.js"');
    }
  });
});

/**
 * Reads the page source; returns an empty string when missing so assertions point directly at the missing content.
 *
 * @param path Page source path.
 * @returns Source text.
 */
function readSource(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
