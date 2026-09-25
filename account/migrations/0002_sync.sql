-- ★ 2026-09-24 / codex round 26: the plan is decided from the list of Stripe subscriptions (do not rely on event order)
--   synced_at = when we started reading the list (ms). Never overwrite with a result whose read started earlier
--   subscription_count = number of live subscriptions (2 or more = paying twice)
ALTER TABLE accounts ADD COLUMN synced_at INTEGER;
ALTER TABLE accounts ADD COLUMN subscription_count INTEGER;
