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
    expect(resolveCuberouterNodes({ env }).map((node) => node.id)).toEqual(["cn"]);
    expect(
      resolveCuberouterNodes({ env, settings: { nodes: [{ id: "hk", url: "https://from-file.example" }] } })
        .map((node) => node.id)
    ).toEqual(["hk"]);
    expect(resolveCuberouterNodes({ env: { MEMMY_CUBEROUTER_NODES: "" } })).toEqual([]);
  });

  it("pins to a single node when MEMMY_CUBEROUTER_URL is set, ignoring the table", () => {
    expect(resolveCuberouterNodes({
      env: {
        MEMMY_CUBEROUTER_URL: "http://127.0.0.1:3000/",
        MEMMY_CUBEROUTER_NODES: "cn=https://from-env.example,hk=https://other.example"
      }
    })).toEqual([{ id: "default", url: "http://127.0.0.1:3000" }]);
  });
});
