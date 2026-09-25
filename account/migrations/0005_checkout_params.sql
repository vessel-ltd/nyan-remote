-- ★ 2026-09-24 / codex round 29: a half-made Checkout keeps the exact values it was created with, and the id once created
ALTER TABLE accounts ADD COLUMN checkout_params TEXT;
ALTER TABLE accounts ADD COLUMN checkout_session TEXT;
