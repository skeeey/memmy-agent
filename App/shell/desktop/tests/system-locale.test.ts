import { describe, expect, it, vi } from "vitest";
import { applySystemLanguageSwitch, resolveSystemLanguage } from "../src/main/system-locale.js";

describe("system language switch", () => {
  it("asks Chromium for the system locale, so the renderer's navigator.language is the real one", () => {
    // Without this the renderer reports whatever Chromium defaulted to (en-US), and a Chinese
    // Windows is handed an English UI while the stored setting still says "system".
    const appendSwitch = vi.fn();

    applySystemLanguageSwitch({ commandLine: { appendSwitch } } as never, () => "zh-CN");

    expect(appendSwitch).toHaveBeenCalledWith("lang", "zh-CN");
  });

  it("leaves the switch alone when the system locale cannot be read", () => {
    const appendSwitch = vi.fn();

    applySystemLanguageSwitch({ commandLine: { appendSwitch } } as never, () => "");

    expect(appendSwitch).not.toHaveBeenCalled();
  });

  it("never lets a failing locale read take the app down", () => {
    // This runs on the startup path, before anything can report a problem: Electron's own
    // getSystemLocale throws there ("can only be called after app is ready"), and an
    // unguarded throw is a crash on launch with no window and no log to read.
    const appendSwitch = vi.fn();

    applySystemLanguageSwitch({ commandLine: { appendSwitch } } as never, () => {
      throw new Error("can only be called after app is ready");
    });

    expect(appendSwitch).not.toHaveBeenCalled();
  });

  it("reads a locale before the app is ready, without Electron's help", () => {
    expect(resolveSystemLanguage()).toMatch(/^[a-z]{2,3}(-|$)/i);
  });
});
