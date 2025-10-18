const crypto = require('crypto');

class ShopifyService {
  constructor({ domain, accessToken, webhookSecret, storeName }) {
    this.domain = domain;
    this.accessToken = accessToken;
    this.webhookSecret = webhookSecret;
    this.storeName = storeName;
    this.baseUrl = `https://${domain}/admin/api/2024-10`;
  }

  async makeRequest(endpoint, method = 'GET', body = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify API error (${this.storeName}): ${error}`);
    }

    return response.json();
  }

  verifyWebhook(body, hmac) {
    const hash = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(body)
      .digest('base64');
    return hash === hmac;
  }

  async getLocationByName(locationName) {
    const response = await this.makeRequest('/locations.json');
    const location = response.locations.find(loc => loc.name === locationName);
    if (!location) {
      throw new Error(`Location "${locationName}" not found in ${this.storeName}`);
    }
    return location;
  }

  async getProductsByTag(tag) {
    let allProducts = [];
    let url = `/products.json?limit=250&fields=id,title,tags,variants`;
    
    while (url) {
      const response = await this.makeRequest(url);
      const products = response.products.filter(p => 
        p.tags.split(',').map(t => t.trim()).includes(tag)
      );
      allProducts = allProducts.concat(products);
      
      url = null; // Simplified pagination for now
    }
    
    return allProducts;
  }

  async getProductByEan(ean) {
    // Search by barcode using GraphQL would be better, but REST API workaround:
    const response = await this.makeRequest(
      `/products.json?limit=250&fields=id,title,tags,variants`
    );
    
    for (const product of response.products) {
      const variant = product.variants.find(v => v.barcode === ean);
      if (variant) {
        return { product, variant };
      }
    }
    
    return null;
  }

  async getInventoryLevel(inventoryItemId, locationId) {
    const response = await this.makeRequest(
      `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationId}`
    );
    return response.inventory_levels[0];
  }

  async adjustInventoryLevel(inventoryItemId, locationId, delta) {
    return this.makeRequest('/inventory_levels/adjust.json', 'POST', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available_adjustment: delta
    });
  }

  async setInventoryLevel(inventoryItemId, locationId, available) {
    return this.makeRequest('/inventory_levels/set.json', 'POST', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: available
    });
  }

  async setupWebhook(address) {
    // First, get existing webhooks
    const response = await this.makeRequest('/webhooks.json');
    const existing = response.webhooks.find(w => 
      w.topic === 'inventory_levels/update' && w.address === address
    );

    if (existing) {
      console.log(`✅ Webhook already exists for ${this.storeName}`);
      return existing;
    }

    // Create new webhook
    return this.makeRequest('/webhooks.json', 'POST', {
      webhook: {
        topic: 'inventory_levels/update',
        address: address,
        format: 'json'
      }
    });
  }
}

module.exports = ShopifyService;