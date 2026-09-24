/** Cuberouter node table tests. */
import { describe, expect, it } from "vitest";
import { parseCuberouterNodeTable, resolveCuberouterNodes } from "../cuberouter-nodes.js";

describe("cuberouter node table", () => {
  it("parses id=url pairs", () => {
    expect(parseCuberouterNodeTable("cn=https://cuberouter.cn,hk=https://cuberouter.com")).toEqual([
      { id: "cn", url: "https://cuberouter.cn" },
      { id: "hk", url: "https://cuberouter.com" }
    ]);
  });

  it("drops entries without an id, a url, or an http(s) scheme", () => {
    expect(parseCuberouterNodeTable("cn=,=https://x.example,hk=ftp://y.example,bad")).toEqual([]);
    expect(parseCuberouterNodeTable("  ")).toEqual([]);
  });

  it("lets the config file replace the environment", () => {
    const env = { MEMMY_CUBEROUTER_URLS: "cn=https://from-env.example" };
    expect(resolveCuberouterNodes({ env }).map((node) => node.id)).toEqual(["cn"]);
    expect(
      resolveCuberouterNodes({ env, settings: { urls: [{ id: "hk", url: "https://from-file.example" }] } })
        .map((node) => node.id)
    ).toEqual(["hk"]);
  });

  it("falls back to the shipped table so a build needs no configuration at all", () => {
    // The two deployments this build talks to, and nothing else. An unusable or empty setting
    // is no setting: probes still sort out which one is reachable.
    expect(resolveCuberouterNodes({ env: {} })).toEqual([
      { id: "cn", url: "https://cuberouter.cn" },
      { id: "hk", url: "https://cuberouter.com" }
    ]);
    expect(resolveCuberouterNodes({ env: { MEMMY_CUBEROUTER_URLS: "  " } }).map((node) => node.id))
      .toEqual(["cn", "hk"]);
  });

  it("takes a single line from the environment, so local development needs one variable", () => {
    expect(resolveCuberouterNodes({ env: { MEMMY_CUBEROUTER_URLS: "cn=http://127.0.0.1:3000/" } }))
      .toEqual([{ id: "cn", url: "http://127.0.0.1:3000" }]);
  });
});
