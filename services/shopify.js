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

    // Get Link header for pagination
    const linkHeader = response.headers.get('Link');
    const data = await response.json();
    
    return { data, linkHeader };
  }

  verifyWebhook(body, hmac) {
    const hash = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(body)
      .digest('base64');
    return hash === hmac;
  }

  async getLocationByName(locationName) {
    const { data } = await this.makeRequest('/locations.json');
    const location = data.locations.find(loc => loc.name === locationName);
    if (!location) {
      throw new Error(`Location "${locationName}" not found in ${this.storeName}`);
    }
    return location;
  }

  async getProductsByTag(tag) {
    let allProducts = [];
    let url = `/products.json?limit=250&fields=id,title,tags,variants`;
    
    while (url) {
      const { data, linkHeader } = await this.makeRequest(url);
      const products = data.products.filter(p => 
        p.tags.split(',').map(t => t.trim()).includes(tag)
      );
      allProducts = allProducts.concat(products);
      
      // Check for next page
      url = this.getNextPageUrl(linkHeader);
    }
    
    console.log(`📦 Found ${allProducts.length} products with tag "${tag}" in ${this.storeName}`);
    return allProducts;
  }

  async getProductByEan(ean) {
    console.log(`🔍 Searching for product with EAN ${ean} in ${this.storeName}...`);
    
    let url = `/products.json?limit=250&fields=id,title,tags,variants`;
    let pageCount = 0;
    
    while (url) {
      pageCount++;
      console.log(`  📄 Checking page ${pageCount}...`);
      
      const { data, linkHeader } = await this.makeRequest(url);
      
      for (const product of data.products) {
        for (const variant of product.variants) {
          if (variant.barcode === ean) {
            console.log(`  ✅ Found product: ${product.title} (variant: ${variant.id})`);
            return { product, variant };
          }
        }
      }
      
      // Check for next page
      url = this.getNextPageUrl(linkHeader);
      
      // Safety limit to avoid infinite loops
      if (pageCount > 50) {
        console.log(`  ⚠️  Stopped after 50 pages (12,500 products)`);
        break;
      }
    }
    
    console.log(`  ❌ Product with EAN ${ean} not found after ${pageCount} pages`);
    return null;
  }

  async getInventoryLevel(inventoryItemId, locationId) {
    const { data } = await this.makeRequest(
      `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationId}`
    );
    return data.inventory_levels[0];
  }

  async adjustInventoryLevel(inventoryItemId, locationId, delta) {
    const { data } = await this.makeRequest('/inventory_levels/adjust.json', 'POST', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available_adjustment: delta
    });
    return data;
  }

  async setInventoryLevel(inventoryItemId, locationId, available) {
    const { data } = await this.makeRequest('/inventory_levels/set.json', 'POST', {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: available
    });
    return data;
  }

  async setupWebhook(address) {
    // First, get existing webhooks
    const { data } = await this.makeRequest('/webhooks.json');
    const existing = data.webhooks.find(w => 
      w.topic === 'inventory_levels/update' && w.address === address
    );

    if (existing) {
      console.log(`✅ Webhook already exists for ${this.storeName}`);
      return existing;
    }

    // Create new webhook
    const { data: webhook } = await this.makeRequest('/webhooks.json', 'POST', {
      webhook: {
        topic: 'inventory_levels/update',
        address: address,
        format: 'json'
      }
    });
    return webhook;
  }

  getNextPageUrl(linkHeader) {
    if (!linkHeader) return null;
    
    // Parse Link header to find next page URL
    // Format: <https://domain/admin/api/2024-10/products.json?page_info=xyz>; rel="next"
    const links = linkHeader.split(',');
    for (const link of links) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        // Extract just the path and query params
        const url = new URL(match[1]);
        return url.pathname.replace('/admin/api/2024-10', '') + url.search;
      }
    }
    
    return null;
  }
}

module.exports = ShopifyService;
