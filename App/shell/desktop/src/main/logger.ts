import { app } from "electron";
import { join } from "node:path";
import log from "electron-log/main";
import {
  DEFAULT_LOG_LEVEL,
  parseLogLevel,
  readPersistedLogLevel,
  writePersistedLogLevel,
  type LogLevel
} from "./log-level.js";
import { rollLogFiles } from "./rotating-log-file.js";

const MAX_LOG_SIZE = 5 * 1024 * 1024;

const MAX_LOG_FILES = 5;

export function developerSettingsPath(): string {
  return join(app.getPath("userData"), "developer-settings.json");
}

function mainLogPath(): string {
  return join(app.getPath("logs"), "main.log");
}

export function initLogger(): void {
  log.initialize();
  log.transports.file.resolvePathFn = () => mainLogPath();
  log.transports.file.maxSize = MAX_LOG_SIZE;
  log.transports.file.archiveLogFn = (file) => {
    rollLogFiles(file.path, MAX_LOG_FILES);
  };
  // The backend runs in this process and logs through console. Nothing else catches that, so
  // its output — probe results, login fallbacks, provision failures — only ever reached stdout,
  // which a packaged app started from the shell does not have; diagnosing anything down there
  // meant asking for the database instead. electron-log still writes to stdout as well, so
  // `npm run dev` keeps printing to its terminal.
  Object.assign(console, log.functions);
  applyLogLevel(getCurrentLogLevel());
}

export function applyLogLevel(level: LogLevel): void {
  const normalized = parseLogLevel(level);
  log.transports.file.level = normalized;
  log.transports.console.level = normalized;
}

export function getCurrentLogLevel(): LogLevel {
  return readPersistedLogLevel(developerSettingsPath());
}

export function setLogLevel(level: LogLevel): void {
  const normalized = parseLogLevel(level);
  writePersistedLogLevel(developerSettingsPath(), normalized);
  applyLogLevel(normalized);
}

export { DEFAULT_LOG_LEVEL };
export type { LogLevel };
