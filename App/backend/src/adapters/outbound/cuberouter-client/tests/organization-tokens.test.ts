/** Cuberouter organization token tests. */
import { describe, expect, it, vi } from "vitest";
import { createHttpCuberouterClient } from "../http-cuberouter-client.js";

function clientWith(fetchImpl: typeof fetch) {
  return createHttpCuberouterClient({
    baseUrl: "http://127.0.0.1:3000",
    timeoutMs: 1000,
    fetchImpl
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("cuberouter organizations", () => {
  it("lists the organizations the member belongs to, with their local ids", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        message: "",
        data: [
          { id: 7, name: "MemTensor", role: "owner" },
          { id: 3, name: "Research", role: "member", status: 1 }
        ]
      })
    );

    const organizations = await clientWith(fetchImpl as unknown as typeof fetch).listOrganizations("jwt-1");

    expect(organizations).toEqual([
      { id: "7", name: "MemTensor" },
      { id: "3", name: "Research" }
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3000/api/organizations");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
  });

  it("drops organization rows without a usable id or name", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, message: "", data: [{ id: 7 }, { name: "no-id" }, "nonsense"] })
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).listOrganizations("jwt-1")
    ).resolves.toEqual([]);
  });
});

describe("cuberouter organization tokens", () => {
  it("lists the organization's enabled tokens with their plaintext keys", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        message: "",
        data: {
          items: [
            { id: 11, name: "memmy-desktop", key: "sk-org-desktop", key_preview: "sk-org**********top" },
            { id: 9, name: "batch-job", key: "sk-org-batch" }
          ],
          total: 2,
          page_size: 100
        }
      })
    );

    const tokens = await clientWith(fetchImpl as unknown as typeof fetch)
      .listOrganizationTokens("jwt-1", "7", "memmy-desktop");

    expect(tokens).toEqual([
      { id: 11, name: "memmy-desktop", key: "sk-org-desktop" },
      { id: 9, name: "batch-job", key: "sk-org-batch" }
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    // Only enabled tokens, narrowed to the desktop name, and authenticated as the user.
    expect(url).toBe("http://127.0.0.1:3000/api/organizations/7/tokens?keyword=memmy-desktop&status=1&page_size=100");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
    expect(init.method).toBe("GET");
  });

  it("looks for the token name the caller configured", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: true, message: "", data: { items: [], total: 0 } })
    );

    await clientWith(fetchImpl as unknown as typeof fetch).listOrganizationTokens("jwt-1", "7", "team-desktop");

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("keyword=team-desktop");
  });

  it("drops entries without a usable id, name or key", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        success: true,
        message: "",
        data: { items: [{ id: 1, name: "memmy-desktop" }, { id: 2, key: "sk-x" }, { name: "x", key: "sk-y" }], total: 3 }
      })
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).listOrganizationTokens("jwt-1", "7", "memmy-desktop")
    ).resolves.toEqual([]);
  });

  it("surfaces the server message when the organization denies access", async () => {
    // The middleware aborts with its own payload rather than the usual success envelope, so the
    // message has to come from wherever it sits in the body.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: "organization_access_denied", message: "permission denied" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).listOrganizationTokens("jwt-1", "7", "memmy-desktop")
    ).rejects.toMatchObject({ code: "rejected", message: "permission denied" });
  });

  it("maps a transport failure while listing to service_unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });

    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).listOrganizationTokens("jwt-1", "7", "memmy-desktop")
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });
});
