/** Cuberouter account node memory tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore } from "../index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): { store: ReturnType<typeof createAppStateStore>; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "memmy-node-memory-"));
  roots.push(root);
  const databasePath = join(root, "app.sqlite");
  return { store: createAppStateStore({ databasePath }), databasePath };
}

describe("cuberouter account node memory", () => {
  it("remembers the line per username and survives reopening", () => {
    const { store, databasePath } = createStore();

    expect(store.repositories.cuberouterAccountNode.get("alice")).toBeNull();
    store.repositories.cuberouterAccountNode.set("  alice  ", "cn");
    store.close();

    const reloaded = createAppStateStore({ databasePath });
    // Whitespace is trimmed on both sides, so a padded login name still hits its own row.
    expect(reloaded.repositories.cuberouterAccountNode.get("alice")).toBe("cn");
    expect(reloaded.repositories.cuberouterAccountNode.get("  alice")).toBe("cn");
    reloaded.repositories.cuberouterAccountNode.set("alice", "hk");
    expect(reloaded.repositories.cuberouterAccountNode.get("alice")).toBe("hk");
    reloaded.close();
  });

  it("keeps usernames case-sensitive", () => {
    const { store } = createStore();

    store.repositories.cuberouterAccountNode.set("Alice", "cn");

    expect(store.repositories.cuberouterAccountNode.get("alice")).toBeNull();
    store.close();
  });
});
