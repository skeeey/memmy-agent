-- Which cuberouter node an account was registered on. The two deployments keep
-- separate accounts, so this is what lets a later login come back to the right one
-- (and what makes the fallback to the other node a one-time cost, not every login).
CREATE TABLE IF NOT EXISTS cuberouter_account_node (
  username TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
