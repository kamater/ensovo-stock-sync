class SyncService {
  constructor(shopifyStore1, shopifyStore2, redisClient) {
    this.store1 = shopifyStore1;
    this.store2 = shopifyStore2;
    this.redis = redisClient;
    this.ensovoLocationName = process.env.ENSOVO_LOCATION_NAME || 'Ensovo';
    this.syncTag = process.env.SYNC_TAG || 'sync-stock';
    this.debounceDelay = parseInt(process.env.DEBOUNCE_DELAY) || 2000;
    this.pendingSyncs = new Map();
  }

  async handleInventoryUpdate(sourceStore, webhookData) {
    try {
      console.log(`\n📥 Inventory update from ${sourceStore}:`, JSON.stringify(webhookData, null, 2));

      const { inventory_item_id, location_id, available } = webhookData;

      // Check if this is the Ensovo location
      const sourceService = sourceStore === 'store1' ? this.store1 : this.store2;
      const ensovoLocation = await sourceService.getLocationByName(this.ensovoLocationName);

      if (location_id !== ensovoLocation.id) {
        console.log(`⏭️  Skipping - not Ensovo location (got ${location_id}, expected ${ensovoLocation.id})`);
        return;
      }

      // Check if this is a sync we triggered (avoid infinite loop)
      const lockKey = `sync:lock:${sourceStore}:${inventory_item_id}`;
      const isLocked = await this.redis.get(lockKey);
      
      if (isLocked) {
        console.log(`🔒 Skipping - sync lock active`);
        return;
      }

      // Find the product by inventory_item_id and check for sync tag
      const productData = await this.findProductByInventoryItem(sourceService, inventory_item_id);
      
      if (!productData) {
        console.log(`⏭️  Product not found for inventory item ${inventory_item_id}`);
        return;
      }

      const { product, variant } = productData;
      
      if (!product.tags.split(',').map(t => t.trim()).includes(this.syncTag)) {
        console.log(`⏭️  Product doesn't have ${this.syncTag} tag`);
        return;
      }

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

  async findProductByInventoryItem(shopifyService, inventoryItemId) {
    // Get all products with sync tag
    const products = await shopifyService.getProductsByTag(this.syncTag);
    
    for (const product of products) {
      for (const variant of product.variants) {
        if (variant.inventory_item_id === inventoryItemId) {
          return { product, variant };
        }
      }
    }
    
    return null;
  }

  async syncDeltaToOtherStore(sourceStore, ean, delta, newValue) {
    try {
      const targetStore = sourceStore === 'store1' ? 'store2' : 'store1';
      const targetService = targetStore === 'store1' ? this.store1 : this.store2;

      console.log(`🔄 Syncing delta for EAN ${ean} from ${sourceStore} to ${targetStore}: ${delta > 0 ? '+' : ''}${delta} (new value: ${newValue})`);

      // Find product in target store by EAN
      const targetProductData = await targetService.getProductByEan(ean);
      
      if (!targetProductData) {
        console.log(`⚠️  Product with EAN ${ean} not found in ${targetStore}`);
        return;
      }

      const { variant: targetVariant } = targetProductData;

      // Get Ensovo location in target store
      const targetEnsovoLocation = await targetService.getLocationByName(this.ensovoLocationName);

      // Set sync lock to prevent infinite loop
      const lockKey = `sync:lock:${targetStore}:${targetVariant.inventory_item_id}`;
      await this.redis.setEx(lockKey, 30, '1'); // Lock for 30 seconds

      // Apply delta to target store
      await targetService.adjustInventoryLevel(
        targetVariant.inventory_item_id,
        targetEnsovoLocation.id,
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

      // Find product in target store by EAN
      const targetProductData = await targetService.getProductByEan(ean);
      
      if (!targetProductData) {
        console.log(`⚠️  Product with EAN ${ean} not found in ${targetStore}`);
        return;
      }

      const { variant: targetVariant } = targetProductData;

      // Get Ensovo location in target store
      const targetEnsovoLocation = await targetService.getLocationByName(this.ensovoLocationName);

      // Set sync lock to prevent infinite loop
      const lockKey = `sync:lock:${targetStore}:${targetVariant.inventory_item_id}`;
      await this.redis.setEx(lockKey, 30, '1');

      // Set absolute value in target store
      await targetService.setInventoryLevel(
        targetVariant.inventory_item_id,
        targetEnsovoLocation.id,
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
    const cacheKey = `inventory:${storeName}:${ean}`;
    await this.redis.del(cacheKey);
    console.log(`🗑️  Cache cleared for ${ean} in ${storeName}`);
  }

  async manualSync(ean, sourceStore) {
    const sourceService = sourceStore === 'store1' ? this.store1 : this.store2;
    
    const productData = await sourceService.getProductByEan(ean);
    if (!productData) {
      throw new Error(`Product with EAN ${ean} not found in ${sourceStore}`);
    }

    const { variant } = productData;
    const location = await sourceService.getLocationByName(this.ensovoLocationName);
    const inventoryLevel = await sourceService.getInventoryLevel(
      variant.inventory_item_id,
      location.id
    );

    await this.syncFullToOtherStore(sourceStore, ean, inventoryLevel.available);
  }
}

module.exports = SyncService;