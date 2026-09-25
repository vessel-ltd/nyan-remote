-- ★ 2026-09-25: what the ops watcher has already alerted on (each alert only once / ops.ts)
CREATE TABLE ops_alerts (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
