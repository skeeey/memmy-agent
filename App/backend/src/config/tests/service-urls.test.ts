/** Service urls tests. */
import { describe, expect, it } from "vitest";
import { resolveCloudClientConfig, resolveCuberouterClientConfig } from "../service-urls.js";

describe("service URL config", () => {
  it("默认网关来自 MEMMY_CLOUD_SERVICE", () => {
    expect(resolveCloudClientConfig({ MEMMY_CLOUD_SERVICE: "https://gw.example.cn" })).toEqual({
      baseUrl: "https://gw.example.cn",
      timeoutMs: 5000
    });
  });

  it("对 MEMMY_CLOUD_SERVICE 做首尾去空白", () => {
    expect(
      resolveCloudClientConfig({ MEMMY_CLOUD_SERVICE: "  https://gw.example.cn  " }).baseUrl
    ).toBe("https://gw.example.cn");
  });

  it("MEMMY_CLOUD_SERVICE 缺失时抛错,不内置 URL 默认值", () => {
    expect(() => resolveCloudClientConfig({})).toThrow(/MEMMY_CLOUD_SERVICE/);
  });

  it("lets MEMMY_CLOUD_URL override the built-in Cloud URL for local debugging", () => {
    expect(
      resolveCloudClientConfig({
        MEMMY_CLOUD_SERVICE: "https://gw.example.cn",
        MEMMY_CLOUD_URL: " http://127.0.0.1:3000 ",
        MEMMY_CLOUD_TIMEOUT_MS: "9000"
      })
    ).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      timeoutMs: 9000
    });
  });

  it("MEMMY_CLOUD_URL 优先级高于 MEMMY_CLOUD_SERVICE", () => {
    expect(
      resolveCloudClientConfig({
        MEMMY_CLOUD_URL: "http://127.0.0.1:3000",
        MEMMY_CLOUD_SERVICE: "https://gw.example.cn"
      }).baseUrl
    ).toBe("http://127.0.0.1:3000");
  });
});

describe("resolveCuberouterClientConfig", () => {
  it("falls back to the local cuberouter instance and deepseek-flash", () => {
    expect(resolveCuberouterClientConfig({})).toMatchObject({
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash",
      timeoutMs: 10_000
    });
  });

  it("honors overrides and strips trailing slashes", () => {
    expect(
      resolveCuberouterClientConfig({
        MEMMY_CUBEROUTER_URL: "https://router.example.com/",
        MEMMY_CUBEROUTER_MODEL: "kimi-k3-a",
        MEMMY_CUBEROUTER_TIMEOUT_MS: "1500"
      })
    ).toMatchObject({
      baseUrl: "https://router.example.com",
      model: "kimi-k3-a",
      timeoutMs: 1_500
    });
  });

  it("prefers env over the config file, and the config file over the defaults", () => {
    expect(resolveCuberouterClientConfig(
      { MEMMY_CUBEROUTER_URL: "https://env.example" },
      { baseUrl: "https://file.example" }
    ).baseUrl).toBe("https://env.example");

    expect(resolveCuberouterClientConfig(
      { MEMMY_CUBEROUTER_URL: "   " },
      { baseUrl: "https://file.example", model: "kimi-k3-a", timeoutMs: 20_000 }
    )).toMatchObject({ baseUrl: "https://file.example", model: "kimi-k3-a", timeoutMs: 20_000 });

    expect(resolveCuberouterClientConfig({})).toMatchObject({
      baseUrl: "http://127.0.0.1:3000",
      model: "deepseek-flash",
      timeoutMs: 10_000
    });
  });

  it("reads the organization token name the build asked for", () => {
    expect(resolveCuberouterClientConfig({ MEMMY_CUBEROUTER_ORG_TOKEN_NAME: " team-desktop " })
      .organizationTokenName).toBe("team-desktop");
    // Unset means the desktop keeps looking for the name it always has.
    expect(resolveCuberouterClientConfig({}).organizationTokenName).toBeNull();
  });

  it("reads the organization whose token supplies the API key", () => {
    expect(resolveCuberouterClientConfig({ MEMMY_CUBEROUTER_ORG: " 7 " }).organizationId).toBe("7");
    // No organization means the build cannot be provisioned, and the caller has to say so.
    expect(resolveCuberouterClientConfig({}).organizationId).toBeNull();
    expect(resolveCuberouterClientConfig({ MEMMY_CUBEROUTER_ORG: "  " }).organizationId).toBeNull();
  });
});
