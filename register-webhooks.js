/**
 * register-webhooks.js
 * 
 * Run this ONCE to register all required Shopify webhooks
 * pointing to your public URL.
 * 
 * Usage:
 *   node register-webhooks.js
 * 
 * Prerequisites:
 *   - APP_URL must be set in .env to your public URL (ngrok/Railway)
 *   - SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_STORE_DOMAIN must be set
 */

require('dotenv').config();
const https = require('https');
const http = require('http');

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_API_SECRET,
  APP_URL,
} = process.env;

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_API_SECRET || !APP_URL) {
  console.error('❌ Missing required env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_API_SECRET, APP_URL');
  process.exit(1);
}

// Strip trailing slash and https:// from domain
const domain = SHOPIFY_STORE_DOMAIN
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');

const webhookUrl = `${APP_URL.replace(/\/$/, '')}/webhooks/shopify`;

const TOPICS = [
  'checkouts/create',
  'checkouts/update',
  'orders/create',
  'orders/paid',
  'orders/fulfilled',
  'orders/updated',
  'refunds/create',
];

async function shopifyRequest(method, path, body) {
  const url = `https://${domain}/admin/api/2024-07/${path}`;
  const bodyStr = body ? JSON.stringify(body) : undefined;
  
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_API_SECRET,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getExistingWebhooks() {
  const res = await shopifyRequest('GET', 'webhooks.json?limit=250');
  if (res.status !== 200) {
    throw new Error(`Failed to list webhooks: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.webhooks || [];
}

async function deleteWebhook(id) {
  await shopifyRequest('DELETE', `webhooks/${id}.json`);
}

async function createWebhook(topic) {
  const res = await shopifyRequest('POST', 'webhooks.json', {
    webhook: {
      topic,
      address: webhookUrl,
      format: 'json',
    },
  });
  return res;
}

async function main() {
  console.log(`\n🔗 Registering Shopify webhooks`);
  console.log(`   Store : https://${domain}`);
  console.log(`   URL   : ${webhookUrl}`);
  console.log(`   Topics: ${TOPICS.length}\n`);

  // Get existing webhooks
  let existing = [];
  try {
    existing = await getExistingWebhooks();
    console.log(`📋 Found ${existing.length} existing webhook(s)`);
  } catch (err) {
    console.error('❌ Could not list webhooks:', err.message);
    console.log('\n💡 If you see 401/403 errors, make sure:');
    console.log('   - SHOPIFY_API_SECRET is your Admin API access token (not the app secret)');
    console.log('   - The app has "write_script_tags" or full read/write scopes');
    process.exit(1);
  }

  // Delete existing webhooks pointing to any URL (clean slate)
  for (const wh of existing) {
    if (wh.address.includes('/webhooks/shopify')) {
      console.log(`  🗑  Removing old webhook: ${wh.topic} → ${wh.address}`);
      await deleteWebhook(wh.id);
    }
  }

  // Register all topics
  let successCount = 0;
  for (const topic of TOPICS) {
    try {
      const res = await createWebhook(topic);
      if (res.status === 201) {
        console.log(`  ✅ ${topic}`);
        successCount++;
      } else {
        console.log(`  ⚠️  ${topic} — ${res.status}: ${JSON.stringify(res.body?.errors || res.body)}`);
      }
    } catch (err) {
      console.log(`  ❌ ${topic} — ${err.message}`);
    }
  }

  console.log(`\n✅ Done! ${successCount}/${TOPICS.length} webhooks registered.`);
  console.log(`\nShopify will now POST to:\n  ${webhookUrl}\n`);
  
  if (successCount < TOPICS.length) {
    console.log('⚠️  Some webhooks failed. Common fixes:');
    console.log('   - Use your Admin API Access Token (Settings → Apps → Develop apps)');
    console.log('   - Make sure the app has webhook write permission');
  }
}

main().catch(console.error);
