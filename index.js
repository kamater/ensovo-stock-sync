require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const zlib = require('zlib');
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
  storeName: 'store1',
  locationId: '107120820601',
  locationName: 'Naturellement bio'
});

const shopifyStore2 = new ShopifyService({
  domain: process.env.SHOPIFY_STORE2_DOMAIN,
  accessToken: process.env.SHOPIFY_STORE2_ACCESS_TOKEN,
  webhookSecret: process.env.SHOPIFY_STORE2_WEBHOOK_SECRET,
  storeName: 'store2',
  locationId: '110812889462',
  locationName: 'Naturellement bio'
});

const syncService = new SyncService(shopifyStore1, shopifyStore2, redisClient);

/* -----------------------------------------------------
   🩺 HEALTH CHECK
----------------------------------------------------- */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* -----------------------------------------------------
   🔒 VERIFY WEBHOOK
----------------------------------------------------- */
function verifyWebhook(shopifyService) {
  return (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    // Si pas de HMAC → ping ou test → on ignore sans bruit
    if (!hmac) {
      return res.status(200).send('pong');
    }

    const rawBody = req.rawBody;

    // Si la vérification échoue → on renvoie 200 silencieusement pour éviter les retries
    if (!shopifyService.verifyWebhook(rawBody, hmac)) {
      // ⏳ Ne log rien, ne bloque pas — évite les retry Shopify
      return res.status(200).send('ignored');
    }

    try {
      req.body = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      // Toujours silencieux
      return res.status(200).send('ignored');
    }

    next();
  };
}

/* -----------------------------------------------------
   ⚙️ MIDDLEWARES (gzip-safe)
----------------------------------------------------- */
app.use('/webhooks', express.raw({
  type: 'application/json',
  verify: (req, res, buf, encoding) => {
    // Conserver le body brut, y compris s’il est compressé (gzip)
    if (encoding === 'gzip') {
      req.rawBody = Buffer.from(buf);
    } else {
      req.rawBody = buf;
    }
  }
}));
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
      console.log(`📍 Store 1: ${process.env.SHOPIFY_STORE1_DOMAIN} - Location: "${shopifyStore1.locationName}" (ID: ${shopifyStore1.locationId})`);
      console.log(`📍 Store 2: ${process.env.SHOPIFY_STORE2_DOMAIN} - Location: "${shopifyStore2.locationName}" (ID: ${shopifyStore2.locationId})`);
      console.log(`🏷️  Sync tag: ${process.env.SYNC_TAG}`);
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
