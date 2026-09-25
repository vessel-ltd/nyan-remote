-- ★ Accounts and billing (2026-09-24 / docs/BILLING.md §2.1). ⚠️ No email, no password, no GitHub token is stored
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  stripe_customer TEXT UNIQUE,
  subscription_id TEXT,
  subscription_status TEXT,
  subscription_event_at INTEGER,
  created INTEGER NOT NULL
);
-- ⚠️ Only the hash of the passphrase
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  cred_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  agent_key TEXT,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX machines_account ON machines(account_id);
-- ★ Process each Stripe event exactly once
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
