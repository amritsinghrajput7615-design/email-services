/**
 * go-live.js
 * 
 * All-in-one script that:
 *  1. Opens a public HTTPS tunnel to localhost:3000
 *  2. Updates APP_URL in .env automatically
 *  3. Registers all 7 Shopify webhooks pointing to the tunnel URL
 *  4. Keeps the tunnel alive and logs incoming requests
 * 
 * Run this WHILE your server is running (npm run dev in another window):
 *   node go-live.js
 */

require('dotenv').config();
const localtunnel = require('localtunnel');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000');
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';
// Use Admin API Access Token (shpat_...) for API calls — NOT the client secret (shpss_...)
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_API_SECRET || '';
const ENV_FILE = path.join(__dirname, '.env');

const WEBHOOK_TOPICS = [
  'checkouts/create',
  'checkouts/update',
  'orders/create',
  'orders/paid',
  'orders/fulfilled',
  'orders/updated',
  'refunds/create',
];

// ─── Helpers ──────────────────────────────────────────────────

function updateEnvFile(key, value) {
  let content = fs.readFileSync(ENV_FILE, 'utf8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const newLine = `${key}="${value}"`;
  if (regex.test(content)) {
    content = content.replace(regex, newLine);
  } else {
    content += `\n${newLine}`;
  }
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

function shopifyRequest(method, path, body) {
  const domain = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${domain}/admin/api/2024-07/${path}`;
  const data = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function registerWebhooks(webhookUrl) {
  console.log('\n📋 Registering Shopify webhooks...');

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
    console.log('⚠️  SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN not set in .env');
    console.log('   Skipping webhook registration. Set them and re-run.');
    return;
  }

  // List and delete old webhooks for this path
  try {
    const list = await shopifyRequest('GET', 'webhooks.json?limit=250');
    if (list.status === 200) {
      for (const wh of list.body.webhooks || []) {
        if (wh.address.includes('/webhooks/shopify')) {
          await shopifyRequest('DELETE', `webhooks/${wh.id}.json`);
          console.log(`   🗑  Removed old: ${wh.topic}`);
        }
      }
    } else if (list.status === 401 || list.status === 403) {
      console.log('\n❌ Shopify API returned 401/403 — Access denied.');
      console.log('   Your SHOPIFY_API_SECRET needs to be the Admin API ACCESS TOKEN.');
      console.log('   Get it from: Shopify Admin → Settings → Apps → Develop apps');
      console.log('   → Your app → API credentials → Admin API access token\n');
      return;
    }
  } catch (err) {
    console.log('   ⚠️  Could not fetch existing webhooks:', err.message);
  }

  // Register all topics
  let ok = 0;
  for (const topic of WEBHOOK_TOPICS) {
    try {
      const res = await shopifyRequest('POST', 'webhooks.json', {
        webhook: { topic, address: webhookUrl, format: 'json' },
      });
      if (res.status === 201) {
        console.log(`   ✅ ${topic}`);
        ok++;
      } else {
        const err = res.body?.errors || res.body;
        console.log(`   ❌ ${topic} → ${res.status}: ${JSON.stringify(err)}`);
      }
    } catch (e) {
      console.log(`   ❌ ${topic} → ${e.message}`);
    }
  }
  console.log(`\n   ${ok}/${WEBHOOK_TOPICS.length} webhooks registered.\n`);
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀 Starting public tunnel...\n');

  let tunnel;
  try {
    tunnel = await localtunnel({
      port: PORT,
      subdomain: 'celfcare-email',
    });
  } catch {
    // Subdomain taken, get a random one
    tunnel = await localtunnel({ port: PORT });
  }

  const tunnelUrl = tunnel.url;
  const webhookUrl = `${tunnelUrl}/webhooks/shopify`;

  console.log('┌─────────────────────────────────────────────────┐');
  console.log(`│  ✅ TUNNEL ACTIVE                                │`);
  console.log(`│  Public URL : ${tunnelUrl.padEnd(34)} │`);
  console.log(`│  Webhook URL: ${webhookUrl.substring(0, 34).padEnd(34)} │`);
  console.log('└─────────────────────────────────────────────────┘');

  // Persist URL to .env
  updateEnvFile('APP_URL', tunnelUrl);
  console.log(`\n✏️  Updated APP_URL in .env → ${tunnelUrl}`);

  // Register Shopify webhooks
  await registerWebhooks(webhookUrl);

  console.log('═══════════════════════════════════════════════════');
  console.log('  🎯 HOW TO TEST');
  console.log('───────────────────────────────────────────────────');
  console.log('  1. Keep this window open (tunnel must stay alive)');
  console.log('  2. Go to your Shopify store in another window');
  console.log('  3. Add a product to cart → start checkout → enter');
  console.log('     your email → close the tab (abandon cart)');
  console.log('  4. Wait 36 seconds (reminder delay set to 36s)');
  console.log('  5. Check your email inbox!');
  console.log('  6. View dashboard: http://localhost:3000/dashboard');
  console.log('───────────────────────────────────────────────────');
  console.log(`  Dashboard : http://localhost:${PORT}/dashboard`);
  console.log(`  Health    : ${tunnelUrl}/health`);
  console.log('═══════════════════════════════════════════════════\n');

  // ── Localtunnel bypass header (required for loca.lt) ─────────
  // loca.lt shows a "tunnel password" page for browser visitors.
  // Shopify bypasses this automatically via the request headers.
  // But if you visit the URL in a browser, click "Click to Continue".

  tunnel.on('close', () => {
    console.log('\n⚠️  Tunnel closed. Re-run this script to reconnect.\n');
    process.exit(0);
  });

  tunnel.on('error', (err) => {
    console.error('Tunnel error:', err.message);
  });

  // Keep alive — print a heartbeat every 2 minutes
  setInterval(() => {
    process.stdout.write(`[${new Date().toLocaleTimeString()}] Tunnel alive: ${tunnelUrl}\n`);
  }, 120000);

  console.log('⏳ Waiting for Shopify webhooks... (Ctrl+C to stop)\n');
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
