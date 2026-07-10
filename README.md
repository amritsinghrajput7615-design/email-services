# Shopify Email Automation Service

A production-ready **transactional and lifecycle email automation** backend for Shopify + Shiprocket. Automatically sends the right email to the right customer at every stage of their journey — cart abandonment, order confirmation, shipping updates, and refunds.

---

## Features

- ✅ **7 automated email types** (abandoned cart × 2, order confirmation, shipped, out for delivery, delivered, refund)
- ✅ **Shopify webhooks** with HMAC signature verification
- ✅ **Shiprocket integration** — real-time webhooks + polling fallback
- ✅ **BullMQ job queue** for delayed abandoned-cart reminders (1h and 24h)
- ✅ **Idempotency** — never sends the same email twice
- ✅ **Retry logic** — 3 attempts with exponential backoff
- ✅ **Unsubscribe support** — CAN-SPAM/GDPR compliant footer on every email
- ✅ **Admin dashboard** — view sent emails, abandoned carts, webhook logs, manual resend
- ✅ **Dual email provider** — Resend or SendGrid (switchable via env var)
- ✅ **PostgreSQL** database with Prisma ORM
- ✅ **Redis** for BullMQ queue backend

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (local or hosted e.g. Supabase, Railway)
- Redis 6+ (local or hosted e.g. Upstash, Railway)
- A [Resend](https://resend.com) or [SendGrid](https://sendgrid.com) account
- A Shopify store (Partner or active)
- A Shiprocket account (optional for shipping emails)

---

## Quick Start

### 1. Clone & Install

```bash
cd "email services"
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all required values. At minimum:

```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/email_services"
REDIS_URL="redis://localhost:6379"
SHOPIFY_WEBHOOK_SECRET="your_shopify_webhook_secret"
EMAIL_PROVIDER="resend"
RESEND_API_KEY="re_xxxxxxxxxxxx"
EMAIL_FROM="noreply@yourdomain.com"
EMAIL_FROM_NAME="Your Store"
STORE_NAME="Your Store"
STORE_URL="https://yourstore.com"
APP_URL="https://your-public-url.com"
```

### 3. Initialize Database

```bash
npm run db:push
# Or for proper migrations:
npm run db:migrate
```

### 4. Start the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

Server starts on `http://localhost:3000` (or your configured `PORT`).

---

## Connecting Shopify Webhooks

### A. Using Shopify CLI (recommended)

```bash
shopify webhook create \
  --topic checkouts/create \
  --address https://your-app-url.com/webhooks/shopify

shopify webhook create \
  --topic checkouts/update \
  --address https://your-app-url.com/webhooks/shopify

shopify webhook create \
  --topic orders/create \
  --address https://your-app-url.com/webhooks/shopify

shopify webhook create \
  --topic orders/paid \
  --address https://your-app-url.com/webhooks/shopify

shopify webhook create \
  --topic orders/fulfilled \
  --address https://your-app-url.com/webhooks/shopify

shopify webhook create \
  --topic orders/updated \
  --address https://your-app-url.com/webhooks/shopify

shopify webhook create \
  --topic refunds/create \
  --address https://your-app-url.com/webhooks/shopify
```

### B. Via Shopify Admin API

Make a `POST` request to `https://{store}.myshopify.com/admin/api/2024-07/webhooks.json`:

```json
{
  "webhook": {
    "topic": "orders/paid",
    "address": "https://your-app-url.com/webhooks/shopify",
    "format": "json"
  }
}
```

### C. Set the Webhook Secret

In your Shopify Partners dashboard → App setup → Webhooks, copy the **webhook signing secret** and set it as `SHOPIFY_WEBHOOK_SECRET` in your `.env`.

---

## Connecting Shiprocket

### Webhook (Recommended)

1. Log into Shiprocket → Settings → Webhooks
2. Add your webhook URL: `https://your-app-url.com/webhooks/shiprocket`
3. Enable status events: Pickup, In Transit, Out for Delivery, Delivered, RTO

### Polling Fallback

Set credentials in `.env`:
```env
SHIPROCKET_EMAIL="your@email.com"
SHIPROCKET_PASSWORD="yourpassword"
SHIPROCKET_POLL_INTERVAL_MINUTES="30"
```

The service will poll Shiprocket every 30 minutes as a fallback.

> **Linking Shiprocket orders to Shopify orders**: When Shiprocket assigns a shipment, update the order via your fulfilment workflow to include the AWB code. The tracking webhook will then match by AWB.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks/shopify` | Shopify webhook receiver (HMAC verified) |
| `POST` | `/webhooks/shiprocket` | Shiprocket webhook receiver |
| `GET` | `/health` | Health check |
| `GET` | `/unsubscribe?token=...` | Customer unsubscribe page |
| `GET` | `/dashboard` | Admin dashboard UI |
| `GET` | `/api/admin/stats` | Email & cart statistics |
| `GET` | `/api/admin/email-logs` | Email send history (paginated) |
| `GET` | `/api/admin/abandoned-carts` | Active & abandoned checkouts |
| `GET` | `/api/admin/webhook-logs` | Raw webhook log viewer |
| `POST` | `/api/admin/resend-email/:id` | Manually resend an email |

---

## Email Templates

All 7 templates are in `src/templates/`. They use [Handlebars](https://handlebarsjs.com/) syntax (`{{variable}}`).

| File | Trigger | Key Variables |
|------|---------|---------------|
| `abandoned_cart_1.html` | 1h after cart abandonment | cartItems, cartTotal, checkoutUrl |
| `abandoned_cart_2.html` | 24h after abandonment | cartItems, discountCode, discountText |
| `order_confirmation.html` | orders/paid webhook | orderNumber, lineItems, shippingAddress |
| `order_shipped.html` | Shiprocket: shipped | awbCode, trackingUrl, courierName |
| `out_for_delivery.html` | Shiprocket: out for delivery | awbCode, trackingUrl, deliveryDate |
| `delivered.html` | Shiprocket: delivered | lineItems, reviewUrl |
| `refund_completed.html` | refunds/create webhook | refundAmount, processingDays, refundMethod |

To customize branding, edit the HTML files directly. Store name, logo, address, and colors all inherit from environment variables.

---

## Admin Dashboard

Visit `http://localhost:3000/dashboard` in your browser.

**Sections:**
- **Email Logs** — All sent/failed emails, filter by type/status, manual resend
- **Abandoned Carts** — Active and abandoned checkouts with customer info
- **Webhook Logs** — Raw incoming webhooks for debugging

To protect the dashboard with a token:
```env
DASHBOARD_TOKEN="your-secret-token"
```
Then access with `?token=your-secret-token` or `Authorization: Bearer your-secret-token`.

---

## Data Model

```
customers       — email, name, unsubscribed flag
checkouts       — Shopify checkout sessions, cart items, reminder job IDs
orders          — Shopify orders, shipping status, AWB code
email_logs      — Every email sent: type, recipient, status, provider message ID
webhook_logs    — Raw webhook payloads for debugging
```

---

## Project Structure

```
email services/
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── server.js              # Express app entry point
│   ├── config/index.js        # Environment variable config
│   ├── db/client.js           # Prisma client
│   ├── middleware/
│   │   ├── shopifyHmac.js     # Webhook signature verification
│   │   └── errorHandler.js
│   ├── services/
│   │   ├── emailService.js    # Send via Resend or SendGrid
│   │   ├── templateService.js # Handlebars template renderer
│   │   ├── abandonedCart.js   # Cart detection + job scheduling
│   │   └── shiprocketService.js # Shiprocket API + status mapping
│   ├── queues/
│   │   ├── emailQueue.js      # BullMQ queue definitions
│   │   └── workers/
│   │       └── emailWorker.js # Email & abandoned cart workers
│   ├── webhooks/
│   │   ├── shopify.js         # Shopify event handlers
│   │   └── shiprocket.js      # Shiprocket event handler
│   ├── routes/
│   │   ├── admin.js           # Admin REST API
│   │   └── unsubscribe.js     # Unsubscribe page
│   ├── jobs/
│   │   └── shiprocketPoller.js # Cron: poll Shiprocket for status
│   ├── templates/             # 7 HTML email templates
│   └── utils/logger.js        # Winston logger
├── public/dashboard/          # Admin dashboard (HTML/CSS/JS)
├── .env.example               # All required env vars
└── package.json
```

---

## Environment Variables Reference

See [`.env.example`](./.env.example) for full documentation of every variable with descriptions and defaults.

---

## Deployment Notes

### Expose Public HTTPS Endpoints

Shopify and Shiprocket need to reach your webhooks over HTTPS. Options:
- **Railway / Render / Fly.io** — Deploy directly, automatic HTTPS
- **ngrok** (development) — `ngrok http 3000`
- **Nginx reverse proxy** with Let's Encrypt

### Production Checklist

- [ ] PostgreSQL and Redis are running and accessible
- [ ] `DATABASE_URL` and `REDIS_URL` point to production instances
- [ ] `npm run db:migrate` has been run
- [ ] `SHOPIFY_WEBHOOK_SECRET` is set to the real webhook secret
- [ ] `EMAIL_FROM` is a verified domain in your email provider
- [ ] `APP_URL` points to your public HTTPS URL (for unsubscribe links)
- [ ] `DASHBOARD_TOKEN` is set to protect the admin UI

---

## License

MIT
