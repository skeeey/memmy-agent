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

  it("lets the config file replace the environment, and survives an empty result", () => {
    const env = { MEMMY_CUBEROUTER_NODES: "cn=https://from-env.example" };
    expect(resolveCuberouterNodes({ env, defaultUrl: "http://127.0.0.1:3000" }).map((node) => node.id)).toEqual(["cn"]);
    expect(
      resolveCuberouterNodes({ env, settings: { nodes: [{ id: "hk", url: "https://from-file.example" }] }, defaultUrl: "http://127.0.0.1:3000" })
        .map((node) => node.id)
    ).toEqual(["hk"]);
    // An unusable table is no table: the resolved default line takes over (see the next test).
    expect(resolveCuberouterNodes({ env: { MEMMY_CUBEROUTER_NODES: "" }, defaultUrl: "http://127.0.0.1:3000" }))
      .toEqual([{ id: "default", url: "http://127.0.0.1:3000" }]);
  });

  it("pins to a single node when MEMMY_CUBEROUTER_URL is set, ignoring the table", () => {
    expect(resolveCuberouterNodes({
      env: {
        MEMMY_CUBEROUTER_URL: "http://127.0.0.1:3000/",
        MEMMY_CUBEROUTER_NODES: "cn=https://from-env.example,hk=https://other.example"
      },
      defaultUrl: "https://ignored.example"
    })).toEqual([{ id: "default", url: "http://127.0.0.1:3000" }]);
  });

  it("falls back to the resolved default line when nothing is configured", () => {
    // Every build before the node table existed resolved one URL (env > config.yaml >
    // localhost). An empty table must keep behaving that way instead of erroring.
    expect(resolveCuberouterNodes({ env: {}, defaultUrl: "https://from-file.example/" })).toEqual([
      { id: "default", url: "https://from-file.example" }
    ]);
    expect(resolveCuberouterNodes({ env: { MEMMY_CUBEROUTER_NODES: "  " }, defaultUrl: "http://127.0.0.1:3000" }))
      .toEqual([{ id: "default", url: "http://127.0.0.1:3000" }]);
  });
});
