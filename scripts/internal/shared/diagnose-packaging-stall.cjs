"use strict";

/**
 * Temporary diagnostic: report what the electron-builder process is doing
 * while it is doing nothing.
 *
 * The CI Windows packaging job stalls inside electron-builder's app-file walk
 * and prints nothing for the whole of it — the last line is electron-builder's
 * own "afterExtract", and forty minutes later the job is killed by its
 * timeout. This preloads into that process (NODE_OPTIONS=--require) and
 * answers the two questions the log cannot: is it spinning or blocked, and if
 * it is blocked, on which path.
 *
 * It wraps the fs promise API to track in-flight calls, prints a heartbeat
 * while the build runs, and once the stall is longer than
 * MEMMY_PROBE_ABORT_MS (default 8 minutes) prints the full picture and exits
 * the build, so the failing run costs minutes instead of the job timeout.
 *
 * The packaging chain starts many node processes, so this stays dormant
 * unless the process is the electron-builder one and MEMMY_PACKAGING_PROBE=1.
 */

try {
  arm();
} catch (error) {
  // Never break a build over the diagnostic itself.
  console.error(`[probe] failed to arm: ${error && error.stack ? error.stack : error}`);
}

function arm() {
  if (process.env.MEMMY_PACKAGING_PROBE !== "1") {
    return;
  }
  if (!/electron-builder/.test(process.argv.join(" "))) {
    return;
  }

  const fs = require("node:fs");

  const WRAPPED = ["lstat", "stat", "readdir", "readlink", "realpath", "copyFile", "mkdir", "rm", "unlink", "rename", "open"];
  const HEARTBEAT_MS = Number(process.env.MEMMY_PROBE_HEARTBEAT_MS || 30000);
  const ABORT_MS = Number(process.env.MEMMY_PROBE_ABORT_MS || 480000);

  const inflight = new Map();
  const totals = new Map();
  const recent = [];
  let sequence = 0;

  const describe = (value) => {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof URL) {
      return value.href;
    }
    if (value instanceof Buffer) {
      return `<buffer ${value.length}>`;
    }
    return String(value);
  };

  for (const name of WRAPPED) {
    const original = fs.promises[name];
    if (typeof original !== "function") {
      continue;
    }
    fs.promises[name] = function (...args) {
      const id = ++sequence;
      // The Error is stored, not formatted: V8 captures the frames cheaply and
      // formats the string only if we ever print it.
      const record = { op: name, path: describe(args[0]), startedAt: Date.now(), stack: new Error() };
      inflight.set(id, record);
      totals.set(name, (totals.get(name) || 0) + 1);
      let pending;
      try {
        pending = original.apply(this, args);
      } catch (error) {
        inflight.delete(id);
        throw error;
      }
      const done = () => {
        inflight.delete(id);
        if (recent.length >= 40) {
          recent.shift();
        }
        recent.push(`${name} ${record.path}`);
      };
      return pending.then(
        (value) => {
          done();
          return value;
        },
        (error) => {
          done();
          return Promise.reject(error);
        }
      );
    };
  }

  const handleSummary = () => {
    const counts = new Map();
    try {
      for (const handle of process._getActiveHandles()) {
        const name = (handle && handle.constructor && handle.constructor.name) || "unknown";
        const detail =
          name === "Socket" && handle.fd != null
            ? `Socket(fd=${handle.fd} remote=${handle.remoteAddress || "?"}:${handle.remotePort || "?"})`
            : name;
        counts.set(detail, (counts.get(detail) || 0) + 1);
      }
    } catch (error) {
      return `<unavailable: ${error.message}>`;
    }
    return [...counts].map(([name, count]) => `${name}x${count}`).join(" ") || "none";
  };

  const report = (label) => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const lines = [];
    lines.push(
      `[probe ${label}] at=${new Date().toISOString()} uptime=${Math.round(process.uptime())}s ` +
        `cpuUser=${Math.round(cpu.user / 1000)}ms cpuSystem=${Math.round(cpu.system / 1000)}ms ` +
        `rss=${Math.round(memory.rss / 1024 / 1024)}MB inflight=${inflight.size}`
    );
    lines.push(`[probe ${label}] completed so far: ${[...totals].map(([op, count]) => `${op}=${count}`).join(" ") || "none"}`);
    const oldest = [...inflight.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, 6);
    for (const record of oldest) {
      lines.push(`[probe ${label}] in flight ${((now - record.startedAt) / 1000).toFixed(1)}s: ${record.op} ${record.path}`);
      lines.push(
        `[probe ${label}]   called from ${String(record.stack.stack)
          .split("\n")
          .slice(1)
          .filter((frame) => !frame.includes(__filename))
          .slice(0, 4)
          .map((frame) => frame.trim())
          .join(" <- ")}`
      );
    }
    if (label !== "heartbeat") {
      lines.push(`[probe ${label}] active handles: ${handleSummary()}`);
      lines.push(`[probe ${label}] last completed: ${recent.slice(-12).join(" | ") || "none"}`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  };

  process.stderr.write(`[probe startup] packaging probe armed pid=${process.pid} argv=${process.argv.join(" ")}\n`);
  setInterval(() => report("heartbeat"), HEARTBEAT_MS).unref();
  setTimeout(() => {
    report("abort");
    process.stderr.write(`[probe abort] exiting after ${ABORT_MS}ms with the report above\n`);
    process.exit(1);
  }, ABORT_MS).unref();
}
