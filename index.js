require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');
const ShopifyService = require('./services/shopify');
const SyncService = require('./services/sync');

const app = express();
const PORT = process.env.PORT || 3000;

/* -----------------------------------------------------
   🔧 CONFIG REDIS
----------------------------------------------------- */
const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

/* -----------------------------------------------------
   🏪 INIT SHOPIFY SERVICES
----------------------------------------------------- */
const shopifyStore1 = new ShopifyService({
  domain: process.env.SHOPIFY_STORE1_DOMAIN,
  accessToken: process.env.SHOPIFY_STORE1_ACCESS_TOKEN,
  webhookSecret: process.env.SHOPIFY_STORE1_WEBHOOK_SECRET,
  storeName: 'store1'
});

const shopifyStore2 = new ShopifyService({
  domain: process.env.SHOPIFY_STORE2_DOMAIN,
  accessToken: process.env.SHOPIFY_STORE2_ACCESS_TOKEN,
  webhookSecret: process.env.SHOPIFY_STORE2_WEBHOOK_SECRET,
  storeName: 'store2'
});

const syncService = new SyncService(shopifyStore1, shopifyStore2, redisClient);

/* -----------------------------------------------------
   🩺 HEALTH CHECK
----------------------------------------------------- */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* -----------------------------------------------------
   🔒 ROBUST WEBHOOK VERIFICATION (Render-safe)
----------------------------------------------------- */
function verifyWebhook(shopifyService) {
  return (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    // Ignorer les pings ou webhooks de test sans HMAC
    if (!hmac) {
      console.log(`🩵 Ignored ping/test webhook from ${shop || 'unknown'}`);
      return res.status(200).send('pong');
    }

    // Forcer le corps en Buffer pour compatibilité Render/Vercel
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(
          typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body),
          'utf8'
        );

    // Vérification HMAC
    if (!shopifyService.verifyWebhook(rawBody, hmac)) {
      console.error(`🚫 Webhook verification failed (${topic || 'unknown'})`);
      return res.status(401).send('Unauthorized');
    }

    // Parsing JSON après vérification
    try {
      req.body = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      console.error('❌ JSON parse error:', err);
      return res.status(400).send('Bad Request');
    }

    next();
  };
}

/* -----------------------------------------------------
   ⚙️ MIDDLEWARES
----------------------------------------------------- */
// Le raw body parser doit s’appliquer avant le JSON parser
app.use('/webhooks', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

/* -----------------------------------------------------
   📦 WEBHOOK ENDPOINTS
----------------------------------------------------- */
app.post('/webhooks/store1/inventory',
  verifyWebhook(shopifyStore1),
  async (req, res) => {
    res.status(200).send('OK');
    await syncService.handleInventoryUpdate('store1', req.body);
  }
);

app.post('/webhooks/store2/inventory',
  verifyWebhook(shopifyStore2),
  async (req, res) => {
    res.status(200).send('OK');
    await syncService.handleInventoryUpdate('store2', req.body);
  }
);

/* -----------------------------------------------------
   🧭 MANUAL SYNC + DEBUG ENDPOINTS
----------------------------------------------------- */
app.post('/sync/manual', async (req, res) => {
  try {
    const { ean, sourceStore } = req.body;
    await syncService.manualSync(ean, sourceStore);
    res.json({ success: true, message: 'Manual sync triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/setup/webhooks', async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || `https://${req.get('host')}`;
    await shopifyStore1.setupWebhook(`${baseUrl}/webhooks/store1/inventory`);
    await shopifyStore2.setupWebhook(`${baseUrl}/webhooks/store2/inventory`);
    res.json({ success: true, message: 'Webhooks configured' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/status', async (req, res) => {
  try {
    const stats = await syncService.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/logs', async (req, res) => {
  try {
    const logs = await syncService.getLogs(50);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/cache/clear', async (req, res) => {
  try {
    const { ean, storeName } = req.body;
    await syncService.clearCache(ean, storeName);
    res.json({ success: true, message: 'Cache cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* -----------------------------------------------------
   🚀 START SERVER
----------------------------------------------------- */
async function start() {
  try {
    await redisClient.connect();
    console.log('✅ Redis connected');

    app.listen(PORT, () => {
      console.log(`🚀 Ensovo Stock Sync v2.0 running on port ${PORT}`);
      console.log(`📍 Store 1 (MASTER): ${process.env.SHOPIFY_STORE1_DOMAIN}`);
      console.log(`📍 Store 2 (DESTINATION): ${process.env.SHOPIFY_STORE2_DOMAIN}`);
      console.log(`🏷️  Sync tag: ${process.env.SYNC_TAG}`);
      console.log(`📦 Location: ${process.env.ENSOVO_LOCATION_NAME}`);
    });
  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
}

/* -----------------------------------------------------
   🧹 GRACEFUL SHUTDOWN
----------------------------------------------------- */
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await redisClient.quit();
  process.exit(0);
});

start();
