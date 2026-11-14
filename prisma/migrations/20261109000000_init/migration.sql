
-- CreateEnum
CREATE TYPE "account_type" AS ENUM ('PREMIUM', 'OFFLINE');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('PLAYER', 'ADMIN');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('PENDING_LINK', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "link_purpose" AS ENUM ('LINK', 'RESET');

-- CreateEnum
CREATE TYPE "tx_type" AS ENUM ('PLAYTIME', 'PURCHASE', 'REFUND', 'ADMIN_GIVE', 'ADMIN_TAKE', 'ADMIN_SET');

-- CreateEnum
CREATE TYPE "product_type" AS ENUM ('ITEM', 'CRATE_KEY', 'COSMETIC', 'RANK', 'PERMISSION', 'COMMAND');

-- CreateEnum
CREATE TYPE "purchase_source" AS ENUM ('WEB', 'GAME');

-- CreateEnum
CREATE TYPE "purchase_status" AS ENUM ('PENDING_DELIVERY', 'DELIVERED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "reward_status" AS ENUM ('PENDING', 'CLAIMED', 'DELIVERED', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "display_name" VARCHAR(32) NOT NULL,
    "minecraft_username" VARCHAR(16) NOT NULL,
    "minecraft_username_lower" VARCHAR(16) NOT NULL,
    "account_type" "account_type" NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'PLAYER',
    "status" "user_status" NOT NULL DEFAULT 'PENDING_LINK',
    "link_deadline" TIMESTAMPTZ(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "minecraft_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mc_uuid" UUID NOT NULL,
    "username" VARCHAR(16) NOT NULL,
    "user_id" UUID,
    "account_type" "account_type",
    "online_mode_verified" BOOLEAN NOT NULL DEFAULT false,
    "linked_at" TIMESTAMPTZ(3),
    "playtime_total_seconds" INTEGER NOT NULL DEFAULT 0,
    "playtime_carry_seconds" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "minecraft_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_hash" TEXT NOT NULL,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" "link_purpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_balances" (
    "mc_account_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_balances_pkey" PRIMARY KEY ("mc_account_id")
);

-- CreateTable
CREATE TABLE "token_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mc_account_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "type" "tx_type" NOT NULL,
    "reason" VARCHAR(255),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "purchase_id" UUID,
    "actor_user_id" UUID,
    "actor_label" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playtime_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mc_account_id" UUID NOT NULL,
    "server_id" UUID,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "eligible_seconds" INTEGER NOT NULL,
    "afk_seconds" INTEGER NOT NULL DEFAULT 0,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "rate_seconds" INTEGER NOT NULL,
    "tokens_awarded" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playtime_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "icon_material" VARCHAR(64) NOT NULL DEFAULT 'CHEST',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(2000) NOT NULL DEFAULT '',
    "image_url" VARCHAR(512),
    "price" INTEGER NOT NULL,
    "type" "product_type" NOT NULL,
    "icon_material" VARCHAR(64) NOT NULL DEFAULT 'PAPER',
    "lore" TEXT[],
    "commands" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "stock_limit" INTEGER,
    "stock_sold" INTEGER NOT NULL DEFAULT 0,
    "per_player_limit" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mc_account_id" UUID NOT NULL,
    "user_id" UUID,
    "product_id" UUID,
    "product_name" VARCHAR(64) NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "source" "purchase_source" NOT NULL,
    "status" "purchase_status" NOT NULL DEFAULT 'PENDING_DELIVERY',
    "idempotency_key" VARCHAR(128) NOT NULL,
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_queue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purchase_id" UUID NOT NULL,
    "mc_account_id" UUID NOT NULL,
    "commands" TEXT[],
    "status" "reward_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "commands_completed" INTEGER NOT NULL DEFAULT 0,
    "claimed_by_server_id" UUID,
    "claimed_at" TIMESTAMPTZ(3),
    "lease_expires_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(64) NOT NULL,
    "plugin_version" VARCHAR(32),
    "server_version" VARCHAR(64),
    "online_mode" BOOLEAN,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_ip" VARCHAR(64),
    "last_error" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_nonces" (
    "nonce_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "server_nonces_pkey" PRIMARY KEY ("nonce_hash")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "actor_label" VARCHAR(64),
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(32),
    "target_id" VARCHAR(64),
    "ip" VARCHAR(64),
    "request_id" VARCHAR(64),
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" VARCHAR(255) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" VARCHAR(160) NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key","window_start")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_minecraft_username_lower_key" ON "users"("minecraft_username_lower");

-- CreateIndex
CREATE UNIQUE INDEX "minecraft_accounts_mc_uuid_key" ON "minecraft_accounts"("mc_uuid");

-- CreateIndex
CREATE UNIQUE INDEX "minecraft_accounts_user_id_key" ON "minecraft_accounts"("user_id");

-- CreateIndex
CREATE INDEX "minecraft_accounts_username_idx" ON "minecraft_accounts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "link_codes_code_hash_key" ON "link_codes"("code_hash");

-- CreateIndex
CREATE INDEX "link_codes_user_id_purpose_idx" ON "link_codes"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "token_transactions_idempotency_key_key" ON "token_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "token_transactions_mc_account_id_created_at_idx" ON "token_transactions"("mc_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "token_transactions_purchase_id_idx" ON "token_transactions"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "playtime_records_idempotency_key_key" ON "playtime_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "playtime_records_mc_account_id_created_at_idx" ON "playtime_records"("mc_account_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_category_id_sort_order_idx" ON "products"("category_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_idempotency_key_key" ON "purchases"("idempotency_key");

-- CreateIndex
CREATE INDEX "purchases_mc_account_id_created_at_idx" ON "purchases"("mc_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "purchases_status_idx" ON "purchases"("status");

-- CreateIndex
CREATE UNIQUE INDEX "reward_queue_purchase_id_key" ON "reward_queue"("purchase_id");

-- CreateIndex
CREATE INDEX "reward_queue_status_mc_account_id_idx" ON "reward_queue"("status", "mc_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_instances_name_key" ON "server_instances"("name");

-- CreateIndex
CREATE INDEX "server_nonces_expires_at_idx" ON "server_nonces"("expires_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_idx" ON "admin_audit_logs"("action");

-- CreateIndex
CREATE INDEX "rate_limit_buckets_window_start_idx" ON "rate_limit_buckets"("window_start");

-- AddForeignKey
ALTER TABLE "minecraft_accounts" ADD CONSTRAINT "minecraft_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_balances" ADD CONSTRAINT "token_balances_mc_account_id_fkey" FOREIGN KEY ("mc_account_id") REFERENCES "minecraft_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_mc_account_id_fkey" FOREIGN KEY ("mc_account_id") REFERENCES "minecraft_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_transactions" ADD CONSTRAINT "token_transactions_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playtime_records" ADD CONSTRAINT "playtime_records_mc_account_id_fkey" FOREIGN KEY ("mc_account_id") REFERENCES "minecraft_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playtime_records" ADD CONSTRAINT "playtime_records_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_mc_account_id_fkey" FOREIGN KEY ("mc_account_id") REFERENCES "minecraft_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_queue" ADD CONSTRAINT "reward_queue_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_queue" ADD CONSTRAINT "reward_queue_mc_account_id_fkey" FOREIGN KEY ("mc_account_id") REFERENCES "minecraft_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_queue" ADD CONSTRAINT "reward_queue_claimed_by_server_id_fkey" FOREIGN KEY ("claimed_by_server_id") REFERENCES "server_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
