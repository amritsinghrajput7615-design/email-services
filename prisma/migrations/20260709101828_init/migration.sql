-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('active', 'abandoned', 'converted');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'paid', 'fulfilled', 'refunded');

-- CreateEnum
CREATE TYPE "ShippingStatus" AS ENUM ('none', 'shipped', 'out_for_delivery', 'delivered', 'returned');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('sent', 'failed', 'retrying');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('received', 'processed', 'error');

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "unsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "unsubscribed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkouts" (
    "id" TEXT NOT NULL,
    "customer_email" TEXT NOT NULL,
    "cart_items" JSONB NOT NULL,
    "total_price" TEXT NOT NULL DEFAULT '0',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "checkout_url" TEXT,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'active',
    "reminder1_job_id" TEXT,
    "reminder2_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "checkout_id" TEXT,
    "customer_email" TEXT NOT NULL,
    "customer_name" TEXT,
    "order_number" TEXT,
    "total_price" TEXT NOT NULL DEFAULT '0',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "line_items" JSONB NOT NULL,
    "shipping_address" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "fulfillment_status" TEXT,
    "shiprocket_shipment_id" TEXT,
    "awb_code" TEXT,
    "tracking_url" TEXT,
    "courier_name" TEXT,
    "shippingStatus" "ShippingStatus" NOT NULL DEFAULT 'none',
    "estimated_delivery" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "email_type" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "order_id" TEXT,
    "checkout_id" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'sent',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "resend_id" TEXT,
    "subject" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'received',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE INDEX "checkouts_customer_email_idx" ON "checkouts"("customer_email");

-- CreateIndex
CREATE INDEX "checkouts_status_idx" ON "checkouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shopify_order_id_key" ON "orders"("shopify_order_id");

-- CreateIndex
CREATE INDEX "orders_customer_email_idx" ON "orders"("customer_email");

-- CreateIndex
CREATE INDEX "orders_shippingStatus_idx" ON "orders"("shippingStatus");

-- CreateIndex
CREATE INDEX "orders_checkout_id_idx" ON "orders"("checkout_id");

-- CreateIndex
CREATE INDEX "email_logs_email_type_idx" ON "email_logs"("email_type");

-- CreateIndex
CREATE INDEX "email_logs_recipient_email_idx" ON "email_logs"("recipient_email");

-- CreateIndex
CREATE INDEX "email_logs_order_id_idx" ON "email_logs"("order_id");

-- CreateIndex
CREATE INDEX "email_logs_checkout_id_idx" ON "email_logs"("checkout_id");

-- CreateIndex
CREATE INDEX "email_logs_status_idx" ON "email_logs"("status");

-- CreateIndex
CREATE INDEX "webhook_logs_source_idx" ON "webhook_logs"("source");

-- CreateIndex
CREATE INDEX "webhook_logs_topic_idx" ON "webhook_logs"("topic");

-- CreateIndex
CREATE INDEX "webhook_logs_status_idx" ON "webhook_logs"("status");

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_customer_email_fkey" FOREIGN KEY ("customer_email") REFERENCES "customers"("email") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_email_fkey" FOREIGN KEY ("customer_email") REFERENCES "customers"("email") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_recipient_email_fkey" FOREIGN KEY ("recipient_email") REFERENCES "customers"("email") ON DELETE RESTRICT ON UPDATE CASCADE;
