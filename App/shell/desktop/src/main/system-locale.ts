import type { app as electronApp } from "electron";

/**
 * Reads the machine's locale without Electron.
 *
 * `app.getSystemLocale()` and `app.getLocale()` both throw before the ready event, and this
 * value is needed *before* ready — Chromium only reads its `lang` switch during startup. Node's
 * ICU is already initialized from the system locale at this point, so it can answer.
 *
 * @returns The locale, or an empty string when it cannot be read.
 */
export function resolveSystemLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "";
  } catch {
    return "";
  }
}

/**
 * Tells Chromium which locale the machine runs, before the app is ready.
 *
 * The renderer's `navigator.language` otherwise reports Chromium's own default (en-US), so a
 * Chinese Windows is handed an English interface even though the stored language setting says
 * "system" — the setting was never able to follow the system it names. A failed read leaves the
 * switch alone rather than propagating: this runs on the startup path, where a throw is a crash
 * on launch with no window and nothing written to the log.
 *
 * @param app The Electron app module.
 * @param systemLocale Reads the machine's locale.
 */
export function applySystemLanguageSwitch(
  app: Pick<typeof electronApp, "commandLine">,
  systemLocale: () => string
): void {
  let locale = "";
  try {
    locale = systemLocale().trim();
  } catch {
    return;
  }
  if (!locale) {
    return;
  }
  app.commandLine.appendSwitch("lang", locale);
}
