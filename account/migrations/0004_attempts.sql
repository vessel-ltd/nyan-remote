-- ★ 2026-09-24 / codex round 28: half-made Checkout attempts (idempotency key and price) and machines being removed
ALTER TABLE accounts ADD COLUMN checkout_key TEXT;
ALTER TABLE accounts ADD COLUMN checkout_price TEXT;
ALTER TABLE machines ADD COLUMN deleting INTEGER;
