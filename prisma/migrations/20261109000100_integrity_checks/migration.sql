-- Database-level safety nets. Application code enforces the same rules; these make
-- it impossible for a bug (or a hand-run query) to corrupt balances or prices.

ALTER TABLE "token_balances"
  ADD CONSTRAINT "token_balances_balance_nonneg" CHECK ("balance" >= 0);

ALTER TABLE "minecraft_accounts"
  ADD CONSTRAINT "minecraft_accounts_playtime_nonneg" CHECK ("playtime_total_seconds" >= 0 AND "playtime_carry_seconds" >= 0);

ALTER TABLE "products"
  ADD CONSTRAINT "products_price_nonneg" CHECK ("price" >= 0),
  ADD CONSTRAINT "products_stock_valid" CHECK ("stock_sold" >= 0 AND ("stock_limit" IS NULL OR ("stock_limit" >= 0 AND "stock_sold" <= "stock_limit"))),
  ADD CONSTRAINT "products_player_limit_valid" CHECK ("per_player_limit" IS NULL OR "per_player_limit" > 0);

ALTER TABLE "purchases"
  ADD CONSTRAINT "purchases_price_nonneg" CHECK ("unit_price" >= 0);

ALTER TABLE "token_transactions"
  ADD CONSTRAINT "token_transactions_balance_after_nonneg" CHECK ("balance_after" >= 0);

ALTER TABLE "playtime_records"
  ADD CONSTRAINT "playtime_records_seconds_valid" CHECK ("eligible_seconds" >= 0 AND "afk_seconds" >= 0 AND "rate_seconds" > 0 AND "tokens_awarded" >= 0);

ALTER TABLE "reward_queue"
  ADD CONSTRAINT "reward_queue_progress_valid" CHECK ("commands_completed" >= 0 AND "attempts" >= 0);
