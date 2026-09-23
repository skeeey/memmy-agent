import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCuberouterSettings, writeCuberouterBaseUrl } from "../cuberouter-access.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-cuberouter-"));
  roots.push(root);
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, body, "utf8");
  return configPath;
}

describe("cuberouter config section", () => {
  it("reads baseUrl/model/timeoutMs from the cuberouter section", async () => {
    const configPath = fixture(
      "cuberouter:\n  baseUrl: https://cuberouter.cn\n  model: kimi-k3-a\n  timeoutMs: 20000\n"
    );

    expect(await readCuberouterSettings(configPath)).toEqual({
      baseUrl: "https://cuberouter.cn",
      model: "kimi-k3-a",
      timeoutMs: 20_000
    });
  });

  it("returns an empty settings object for a missing section, a missing file, or bad types", async () => {
    expect(await readCuberouterSettings(fixture("agents:\n  defaults: {}\n"))).toEqual({});
    expect(await readCuberouterSettings(join(tmpdir(), "definitely-missing-config.yaml"))).toEqual({});
    expect(await readCuberouterSettings(fixture("cuberouter:\n  baseUrl: 42\n  timeoutMs: nope\n"))).toEqual({});
  });

  it("writes baseUrl without disturbing the rest of the file", async () => {
    const configPath = fixture(
      "cuberouter:\n  model: kimi-k3-a\nagents:\n  defaults:\n    workspace: /tmp/w\n"
    );

    await writeCuberouterBaseUrl(configPath, "https://cuberouter.com/");

    expect(await readCuberouterSettings(configPath)).toEqual({
      baseUrl: "https://cuberouter.com",
      model: "kimi-k3-a"
    });
  });
});
