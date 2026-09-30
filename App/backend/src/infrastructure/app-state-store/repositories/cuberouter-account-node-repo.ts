/** Remembers which cuberouter node an account belongs to. */
import type { DatabaseSync } from "node:sqlite";

export interface CuberouterAccountNodeRepository {
  get(username: string): string | null;
  set(username: string, nodeId: string): void;
}

/** Trims only: cuberouter usernames are case-sensitive, so folding case would merge two accounts. */
export function normalizeCuberouterUsername(username: string): string {
  return username.trim();
}

/** Creates create cuberouter account node repository. */
export function createCuberouterAccountNodeRepository(db: DatabaseSync): CuberouterAccountNodeRepository {
  return {
    get(username) {
      const row = db
        .prepare("SELECT node_id FROM cuberouter_account_node WHERE username = ?")
        .get(normalizeCuberouterUsername(username)) as { node_id: string } | undefined;
      return row?.node_id ?? null;
    },

    set(username, nodeId) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO cuberouter_account_node (username, node_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET node_id = excluded.node_id, updated_at = excluded.updated_at`
      ).run(normalizeCuberouterUsername(username), nodeId, now, now);
    }
  };
}
