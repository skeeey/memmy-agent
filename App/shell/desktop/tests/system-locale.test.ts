import { describe, expect, it, vi } from "vitest";
import { applySystemLanguageSwitch } from "../src/main/system-locale.js";

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
});
