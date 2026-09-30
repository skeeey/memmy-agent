import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:process", async () => {
  const { PassThrough } = await import("node:stream");
  return { stdout: new PassThrough(), stderr: new PassThrough() };
});
vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("electron-log/main", () => ({
  default: {
    initialize: vi.fn(),
    transports: { file: { level: "info" }, console: { level: "info" } },
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
vi.mock("../src/main/log-level.js", () => ({
  DEFAULT_LOG_LEVEL: "info",
  parseLogLevel: (level: string) => level,
  readPersistedLogLevel: () => "info",
  writePersistedLogLevel: vi.fn()
}));

beforeEach(() => vi.resetModules());

async function setup() {
  const { stdout, stderr } = await import("node:process");
  stdout.removeAllListeners();
  stderr.removeAllListeners();
  const { default: log } = await import("electron-log/main");
  const logger = await import("../src/main/logger.js");
  logger.initLogger();
  return { stdout, stderr, log, ...logger };
}

describe("desktop console pipe failures", () => {
  it.each(["stdout", "stderr"] as const)("survives %s EPIPE while retaining file logging", async (streamName) => {
    const context = await setup();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => context[streamName].emit("error", error)).not.toThrow();
    expect(context.log.transports.console.level).toBe(false);
    expect(context.log.transports.file.level).toBe("info");
    context.applyLogLevel("debug");
    expect(context.log.transports.console.level).toBe(false);
    expect(context.log.transports.file.level).toBe("debug");
    expect(() => context[streamName].emit("error", error)).not.toThrow();
  });

  it("does not suppress unrelated stream failures", async () => {
    const { stdout } = await setup();
    const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
    expect(() => stdout.emit("error", error)).toThrow(error);
  });

  it("routes the main process's console into the log file", async () => {
    // The backend runs in this process: without the hook its console.info/warn — probe results,
    // login fallbacks, provision failures — only reach stdout, which a packaged app started from
    // the shell does not have.
    const originalConsole = { info: console.info, warn: console.warn, error: console.error };
    try {
      const { log } = await setup();

      console.info("probe result: cn=120ms");
      console.error("provision failed");

      expect(log.functions.info).toHaveBeenCalledWith("probe result: cn=120ms");
      expect(log.functions.error).toHaveBeenCalledWith("provision failed");
    } finally {
      Object.assign(console, originalConsole);
    }
  });

  it("does not install duplicate handlers or revive a broken console on reinitialization", async () => {
    const context = await setup();
    context.initLogger();
    expect(context.stdout.listenerCount("error")).toBe(1);
    expect(context.stderr.listenerCount("error")).toBe(1);
    context.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    context.initLogger();
    expect(context.log.transports.console.level).toBe(false);
  });
});
