import type { app as electronApp } from "electron";

/**
 * Tells Chromium which locale the machine runs, before the app is ready.
 *
 * The renderer's `navigator.language` otherwise reports Chromium's own default (en-US), so a
 * Chinese Windows is handed an English interface even though the stored language setting says
 * "system" — the setting was never able to follow the system it names. Taking the value from
 * `getSystemLocale` (not `getLocale`) keeps this usable before the ready event.
 *
 * @param app The Electron app module.
 * @param systemLocale Reads the machine's locale.
 */
export function applySystemLanguageSwitch(
  app: Pick<typeof electronApp, "commandLine">,
  systemLocale: () => string
): void {
  const locale = systemLocale().trim();
  if (!locale) {
    return;
  }
  app.commandLine.appendSwitch("lang", locale);
}
