/** cuberouter section of the runtime config. */
import { readFileSync } from "node:fs";
import { mutateRuntimeConfig } from "@memmy/migrations";
import YAML from "yaml";

export interface CuberouterSettings {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/** Reads the `cuberouter:` section; a missing section, file, or bad type yields no value. */
export async function readCuberouterSettings(configPath: string): Promise<CuberouterSettings> {
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as unknown;
    return toSettings(record(record(parsed).cuberouter));
  } catch {
    // An unreadable or malformed file is the same as no configuration here: this section is an
    // override, and every caller has a built-in default to fall back to.
    return {};
  }
}

/** Writes the selected line, leaving every other key in the file untouched. */
export async function writeCuberouterBaseUrl(configPath: string, baseUrl: string): Promise<void> {
  await mutateRuntimeConfig(configPath, (root) => {
    root.cuberouter = { ...record(root.cuberouter), baseUrl: normalizeUrl(baseUrl) };
  });
}

function toSettings(input: Record<string, unknown>): CuberouterSettings {
  const baseUrl = optionalString(input.baseUrl);
  const model = optionalString(input.model);
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
    ? input.timeoutMs
    : undefined;
  return {
    ...(baseUrl ? { baseUrl: normalizeUrl(baseUrl) } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs ? { timeoutMs } : {})
  };
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
