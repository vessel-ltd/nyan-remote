-- ★ 2026-09-24 / codex round 27: a per-account lease (only one holder while reading Stripe / creating a Checkout) and the re-read count
ALTER TABLE accounts ADD COLUMN lease_token TEXT;
ALTER TABLE accounts ADD COLUMN lease_until INTEGER;
ALTER TABLE accounts ADD COLUMN sync_wanted INTEGER;
