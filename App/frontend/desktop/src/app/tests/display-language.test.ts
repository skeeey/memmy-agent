// @vitest-environment happy-dom

/** Display language resolution tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDisplayLanguage } from "../providers.js";

describe("resolveDisplayLanguage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lets an explicit choice win", () => {
    expect(resolveDisplayLanguage("en-US")).toBe("en-US");
    expect(resolveDisplayLanguage("zh-CN")).toBe("zh-CN");
  });

  it("follows the system for a Chinese locale, whichever edition the build is", () => {
    // The setting is called "system": a Chinese Windows must not be handed an English UI just
    // because the package was built as the international edition.
    vi.stubEnv("MEMMY_APP_EDITION", "intl");
    vi.stubGlobal("navigator", { language: "zh-CN" });
    expect(resolveDisplayLanguage("system")).toBe("zh-CN");

    vi.stubGlobal("navigator", { language: "zh-TW" });
    expect(resolveDisplayLanguage("system")).toBe("zh-CN");
  });

  it("leaves every other locale to the edition", () => {
    // Two languages ship, so the edition is what picks between them once Chinese is off the
    // table — including the English system that an English build exists for.
    vi.stubGlobal("navigator", { language: "en-GB" });
    vi.stubEnv("MEMMY_APP_EDITION", "intl");
    expect(resolveDisplayLanguage("system")).toBe("en-US");

    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(resolveDisplayLanguage("system")).toBe("en-US");

    vi.stubEnv("MEMMY_APP_EDITION", "cn");
    expect(resolveDisplayLanguage("system")).toBe("zh-CN");
  });
});
