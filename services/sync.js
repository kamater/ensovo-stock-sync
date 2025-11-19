class SyncService {
  constructor(shopifyStore1, shopifyStore2, redisClient) {
    this.store1 = shopifyStore1;
    this.store2 = shopifyStore2;
    this.redis = redisClient;
    this.syncTag = process.env.SYNC_TAG || 'sync-stock';
    this.debounceDelay = parseInt(process.env.DEBOUNCE_DELAY) || 2000;
    this.pendingSyncs = new Map();

    // Cache duration: 30 minutes (configurable via CACHE_DURATION)
    // Cache expires naturally - no auto-refresh to save resources
    this.cacheDuration = parseInt(process.env.CACHE_DURATION) || 1800;
  }

  async handleInventoryUpdate(sourceStore, webhookData) {
    try {
      console.log(`\n📥 Inventory update from ${sourceStore}:`, JSON.stringify(webhookData, null, 2));

      const { inventory_item_id, location_id, available } = webhookData;

      // Check if this is the correct location for this store
      const sourceService = sourceStore === 'store1' ? this.store1 : this.store2;
      const expectedLocationId = parseInt(sourceService.locationId);

      if (location_id !== expectedLocationId) {
        // Try to get product info even if wrong location
        try {
          const allProducts = await sourceService.getProductsByTag(this.syncTag);
          for (const p of allProducts) {
            for (const v of p.variants) {
              if (v.inventory_item_id === inventory_item_id) {
                console.log(`⏭️  Skipping - not ${sourceService.locationName} location (got ${location_id}, expected ${expectedLocationId})`);
                console.log(`   📦 Product: "${p.title}" | SKU: ${v.sku || 'N/A'} | EAN: ${v.barcode || 'N/A'}`);
                return;
              }
            }
          }
        } catch (e) {
          // Ignore errors, just skip
        }
        console.log(`⏭️  Skipping - not ${sourceService.locationName} location (got ${location_id}, expected ${expectedLocationId})`);
        return;
      }

      // Check if this is a sync we triggered (avoid infinite loop)
      const lockKey = `sync:lock:${sourceStore}:${inventory_item_id}`;
      const isLocked = await this.redis.get(lockKey);
      
      if (isLocked) {
        console.log(`🔒 Skipping - sync lock active. Le stock a ete modifie il y a moins de 20 secondes: protection contre les boucles infinies`);
        return;
      }

      // Find the product by inventory_item_id using CACHE
      const productData = await this.findProductByInventoryItemCached(sourceService, sourceStore, inventory_item_id);

      if (!productData) {
        console.log(`⏭️  Product not found or doesn't have ${this.syncTag} tag`);
        return;
      }

      const { product, variant } = productData;

      // LOG PRODUCT INFO
      console.log(`📦 Product: "${product.title}"`);
      console.log(`   SKU: ${variant.sku || 'N/A'}`);
      console.log(`   EAN: ${variant.barcode || 'N/A'}`);
      console.log(`   Variant ID: ${variant.id}`);

      if (!variant.barcode) {
        console.log(`⏭️  Variant has no EAN/barcode`);
        return;
      }

      const ean = variant.barcode;

      // Get previous value from cache
      const cacheKey = `inventory:${sourceStore}:${ean}`;
      const previousValue = await this.redis.get(cacheKey);
      const previousAvailable = previousValue ? parseInt(previousValue) : null;

      // Calculate delta
      let delta = 0;
      if (previousAvailable !== null) {
        delta = available - previousAvailable;
        console.log(`📊 Delta calculation: ${available} - ${previousAvailable} = ${delta}`);
      } else {
        console.log(`ℹ️  No previous value in cache, will do full sync`);
      }

      // Store new value in cache
      await this.redis.setEx(cacheKey, 3600 * 24, available.toString());

      // Debounce and sync
      const debounceKey = `sync:debounce:${sourceStore}:${ean}`;
      await this.debounce(debounceKey, async () => {
        if (previousAvailable !== null && delta !== 0) {
          await this.syncDeltaToOtherStore(sourceStore, ean, delta, available);
        } else if (previousAvailable === null) {
          await this.syncFullToOtherStore(sourceStore, ean, available);
        } else {
          console.log(`⏭️  No change detected (delta = 0)`);
        }
      });

    } catch (error) {
      console.error('❌ Error handling inventory update:', error);
      await this.logError(error, sourceStore, webhookData);
    }
  }

  async findProductByInventoryItemCached(shopifyService, storeName, inventoryItemId) {
    // Try to get from cache first
    const cacheKey = `products:${storeName}:${this.syncTag}`;
    let cachedProducts = await this.redis.get(cacheKey);

    if (!cachedProducts) {
      console.log(`🔄 Cache miss - loading products with tag "${this.syncTag}" from ${storeName}...`);

      // Load products with sync tag
      const products = await shopifyService.getProductsByTag(this.syncTag);

      // Store in cache for 1 hour
      await this.redis.setEx(cacheKey, this.cacheDuration, JSON.stringify(products));
      cachedProducts = JSON.stringify(products);

      console.log(`✅ Cached ${products.length} products for ${storeName}`);
    } else {
      console.log(`✅ Cache hit - using cached products for ${storeName}`);
    }

    const products = JSON.parse(cachedProducts);

    // Find product with matching inventory_item_id
    for (const product of products) {
      for (const variant of product.variants) {
        if (variant.inventory_item_id === inventoryItemId) {
          console.log(`✅ Found product: ${product.title} (inventory_item_id: ${inventoryItemId})`);
          return { product, variant };
        }
      }
    }

    return null;
  }

  async getProductByEanCached(shopifyService, storeName, ean) {
    console.log(`🔍 Searching for product with EAN ${ean} in ${storeName} (cached)...`);

    // Try to get from cache first
    const cacheKey = `products:${storeName}:${this.syncTag}`;
    let cachedProducts = await this.redis.get(cacheKey);

    if (!cachedProducts) {
      console.log(`🔄 Cache miss - loading products with tag "${this.syncTag}" from ${storeName}...`);

      // Load products with sync tag
      const products = await shopifyService.getProductsByTag(this.syncTag);

      // Store in cache for 1 hour
      await this.redis.setEx(cacheKey, this.cacheDuration, JSON.stringify(products));
      cachedProducts = JSON.stringify(products);

      console.log(`✅ Cached ${products.length} products for ${storeName}`);
    } else {
      console.log(`✅ Cache hit - using cached products for ${storeName}`);
    }

    const products = JSON.parse(cachedProducts);

    // Find product with matching EAN
    for (const product of products) {
      for (const variant of product.variants) {
        if (variant.barcode === ean) {
          console.log(`✅ Found product: ${product.title} (EAN: ${ean})`);
          return { product, variant };
        }
      }
    }

    console.log(`❌ Product with EAN ${ean} not found in cache for ${storeName}`);
    return null;
  }

  async syncDeltaToOtherStore(sourceStore, ean, delta, newValue) {
    try {
      const targetStore = sourceStore === 'store1' ? 'store2' : 'store1';
      const targetService = targetStore === 'store1' ? this.store1 : this.store2;

      console.log(`🔄 Syncing delta for EAN ${ean} from ${sourceStore} to ${targetStore}: ${delta > 0 ? '+' : ''}${delta} (new value: ${newValue})`);

      // Find product in target store by EAN (using cache)
      const targetProductData = await this.getProductByEanCached(targetService, targetStore, ean);

      if (!targetProductData) {
        console.log(`⚠️  Product with EAN ${ean} not found in ${targetStore}`);
        return;
      }

      const { variant: targetVariant } = targetProductData;

      // Use the configured location ID for target store
      const targetLocationId = parseInt(targetService.locationId);

      // Set sync lock to prevent infinite loop
      const lockKey = `sync:lock:${targetStore}:${targetVariant.inventory_item_id}`;
      await this.redis.setEx(lockKey, 20, '1'); // Lock for 20 seconds

      // Apply delta to target store
      await targetService.adjustInventoryLevel(
        targetVariant.inventory_item_id,
        targetLocationId,
        delta
      );

      // Update cache for target store
      const targetCacheKey = `inventory:${targetStore}:${ean}`;
      const targetCurrentValue = await this.redis.get(targetCacheKey);
      if (targetCurrentValue) {
        const targetNewValue = parseInt(targetCurrentValue) + delta;
        await this.redis.setEx(targetCacheKey, 3600 * 24, targetNewValue.toString());
        console.log(`✅ Successfully applied delta ${delta > 0 ? '+' : ''}${delta} to ${targetStore} (${targetCurrentValue} → ${targetNewValue})`);
      } else {
        await this.redis.setEx(targetCacheKey, 3600 * 24, newValue.toString());
        console.log(`✅ Successfully applied delta ${delta > 0 ? '+' : ''}${delta} to ${targetStore} (set to ${newValue})`);
      }

      // Log sync event
      await this.logSyncEvent(sourceStore, targetStore, ean, delta, 'delta');

    } catch (error) {
      console.error(`❌ Error syncing delta to other store:`, error);
      throw error;
    }
  }

  async syncFullToOtherStore(sourceStore, ean, available) {
    try {
      const targetStore = sourceStore === 'store1' ? 'store2' : 'store1';
      const targetService = targetStore === 'store1' ? this.store1 : this.store2;

      console.log(`🔄 Full sync for EAN ${ean} from ${sourceStore} to ${targetStore}: ${available} units`);

      // Find product in target store by EAN (using cache)
      const targetProductData = await this.getProductByEanCached(targetService, targetStore, ean);

      if (!targetProductData) {
        console.log(`⚠️  Product with EAN ${ean} not found in ${targetStore}`);
        return;
      }

      const { variant: targetVariant } = targetProductData;

      // Use the configured location ID for target store
      const targetLocationId = parseInt(targetService.locationId);

      // Set sync lock to prevent infinite loop
      const lockKey = `sync:lock:${targetStore}:${targetVariant.inventory_item_id}`;
      await this.redis.setEx(lockKey, 20, '1'); // Lock for 20 seconds

      // Set absolute value in target store
      await targetService.setInventoryLevel(
        targetVariant.inventory_item_id,
        targetLocationId,
        available
      );

      // Update cache for target store
      const targetCacheKey = `inventory:${targetStore}:${ean}`;
      await this.redis.setEx(targetCacheKey, 3600 * 24, available.toString());

      console.log(`✅ Successfully set ${targetStore} to ${available} units`);

      // Log sync event
      await this.logSyncEvent(sourceStore, targetStore, ean, available, 'full');

    } catch (error) {
      console.error(`❌ Error full syncing to other store:`, error);
      throw error;
    }
  }

  async debounce(key, callback) {
    // Clear existing timeout if any
    if (this.pendingSyncs.has(key)) {
      clearTimeout(this.pendingSyncs.get(key));
    }

    // Set new timeout
    const timeoutId = setTimeout(async () => {
      this.pendingSyncs.delete(key);
      await callback();
    }, this.debounceDelay);

    this.pendingSyncs.set(key, timeoutId);
  }

  async logSyncEvent(sourceStore, targetStore, ean, value, type) {
    const timestamp = Date.now();
    const key = `sync:log:${timestamp}:${Math.random().toString(36).substr(2, 9)}`;
    const logData = {
      sourceStore,
      targetStore,
      ean,
      value,
      type,
      timestamp: new Date().toISOString()
    };
    
    await this.redis.setEx(key, 86400 * 7, JSON.stringify(logData)); // Keep for 7 days

    // Increment counter
    await this.redis.incr('sync:count:total');
  }

  async logError(error, sourceStore, webhookData) {
    const timestamp = Date.now();
    const key = `error:log:${timestamp}`;
    await this.redis.setEx(key, 86400 * 7, JSON.stringify({
      error: error.message,
      stack: error.stack,
      sourceStore,
      webhookData,
      timestamp: new Date().toISOString()
    }));

    await this.redis.incr('error:count:total');
  }

  async getStats() {
    const totalSyncs = await this.redis.get('sync:count:total') || 0;
    const totalErrors = await this.redis.get('error:count:total') || 0;
    
    return {
      totalSyncs: parseInt(totalSyncs),
      totalErrors: parseInt(totalErrors),
      timestamp: new Date().toISOString()
    };
  }

  async getLogs(limit = 50) {
    const keys = await this.redis.keys('sync:log:*');
    const sortedKeys = keys.sort().reverse().slice(0, limit);
    
    const logs = [];
    for (const key of sortedKeys) {
      const data = await this.redis.get(key);
      if (data) {
        logs.push(JSON.parse(data));
      }
    }
    
    return logs;
  }

  async clearCache(ean, storeName) {
    if (ean) {
      // Clear inventory cache for specific product
      const inventoryCacheKey = `inventory:${storeName}:${ean}`;
      await this.redis.del(inventoryCacheKey);
      console.log(`🗑️  Inventory cache cleared for EAN ${ean} in ${storeName}`);
    }

    // Clear products cache (will force reload on next webhook)
    const productsCacheKey = `products:${storeName}:${this.syncTag}`;
    await this.redis.del(productsCacheKey);

    console.log(`🗑️  Products cache cleared for ${storeName}`);
  }

  async refreshCache(storeName) {
    const productsCacheKey = `products:${storeName}:${this.syncTag}`;
    await this.redis.del(productsCacheKey);
    console.log(`🔄 Products cache cleared for ${storeName} - will reload on next webhook`);
  }

  async manualSync(ean, sourceStore) {
    const sourceService = sourceStore === 'store1' ? this.store1 : this.store2;

    const productData = await this.getProductByEanCached(sourceService, sourceStore, ean);
    if (!productData) {
      throw new Error(`Product with EAN ${ean} not found in ${sourceStore}`);
    }

    const { variant } = productData;
    const locationId = parseInt(sourceService.locationId);
    const inventoryLevel = await sourceService.getInventoryLevel(
      variant.inventory_item_id,
      locationId
    );

    await this.syncFullToOtherStore(sourceStore, ean, inventoryLevel.available);
  }
}

module.exports = SyncService;
