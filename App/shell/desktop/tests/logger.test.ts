import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: {
    initialize: vi.fn(),
    transports: {
      file: { level: "", maxSize: 0, resolvePathFn: undefined, archiveLogFn: undefined },
      console: { level: "" }
    },
    functions: {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn()
    }
  }
}));

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/memmy-logs" } }));
vi.mock("electron-log/main", () => ({ default: mocks.log }));

import { initLogger } from "../src/main/logger.js";

describe("main process logger", () => {
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };

  afterEach(() => {
    Object.assign(console, originalConsole);
    vi.clearAllMocks();
  });

  it("routes the main process's console into the log file", () => {
    // The backend runs in this process: without the hook its console.info/warn — probe results,
    // login fallbacks, provision failures — only reach stdout, which a packaged app started
    // from the shell does not have. Diagnosing anything there meant asking for the database.
    initLogger();

    console.info("probe result: cn=120ms");

    expect(mocks.log.functions.info).toHaveBeenCalledWith("probe result: cn=120ms");
  });

  it("keeps console.error on the error level so failures stay visible", () => {
    initLogger();

    console.error("provision failed");

    expect(mocks.log.functions.error).toHaveBeenCalledWith("provision failed");
  });
});
