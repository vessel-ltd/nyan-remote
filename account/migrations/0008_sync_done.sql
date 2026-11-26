-- ★ 2026-11-26 / review ACC-1: the hourly re-read (`runUpkeep` in app.ts)
--   sync_done    = the sync_wanted value the last finished re-read reflects (sync_wanted > sync_done = never finished)
--   sync_checked = when the last re-read finished (paid accounts are re-read at least weekly)
--   sync_tried   = when the cron last tried (the least recently tried go first = stuck accounts cannot block the rest)
ALTER TABLE accounts ADD COLUMN sync_done INTEGER;
ALTER TABLE accounts ADD COLUMN sync_checked INTEGER;
ALTER TABLE accounts ADD COLUMN sync_tried INTEGER;
--   sync_watch   = until when the cron re-reads hourly after a Checkout was handed out (a payment whose webhooks were lost)
ALTER TABLE accounts ADD COLUMN sync_watch INTEGER;
-- ★ The re-read has its own lease (codex): Checkout held the one account lease, so a loop of Checkouts blocked the
--   webhook and the cron re-read alike. Checkout keeps lease_token / lease_until (Checkout against Checkout only).
ALTER TABLE accounts ADD COLUMN sync_lease_token TEXT;
ALTER TABLE accounts ADD COLUMN sync_lease_until INTEGER;
-- ★ The latest end any paid subscription is known to run to (`planOf` / codex: with two subscriptions, a monthly one
--   that decides the page must not cut off an annual one already paid for)
ALTER TABLE accounts ADD COLUMN paid_through INTEGER;
