-- ★ 2026-09-27: the account page shows the subscription's next step (store.ts `summarize` / pages.ts `billingLine`)
ALTER TABLE accounts ADD COLUMN subscription_period_end INTEGER;
ALTER TABLE accounts ADD COLUMN subscription_cancelling INTEGER;
ALTER TABLE accounts ADD COLUMN subscription_cancel_at INTEGER;
