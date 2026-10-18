// live.js — the real eBay store, via eBay's REST Sell/Buy APIs and the Trading
// API (buyer messages). Same interface as mock.js.
//
// Note: the Inventory API only sees listings created through it. Listings made
// on ebay.com.au need a one-off migration first (see README → "Migrating
// existing listings").

const BASES = {
  sandbox: 'https://api.sandbox.ebay.com',
  production: 'https://api.ebay.com',
};

const USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly',
].join(' ');

// eBay site IDs for the Trading API
const SITE_IDS = { EBAY_AU: '15', EBAY_US: '0', EBAY_GB: '3' };

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const xmlTag = (xml, tag) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const yyyymmdd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

export function createLiveStore({ mode, env = process.env }) {
  const base = BASES[mode];
  if (!base) throw new Error(`Unknown EBAY_MODE "${mode}"`);
  for (const k of ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN']) {
    if (!env[k]) throw new Error(`${k} is required when EBAY_MODE=${mode}. See README → eBay setup.`);
  }
  const marketplace = env.EBAY_MARKETPLACE_ID || 'EBAY_AU';
  const currency = marketplace === 'EBAY_AU' ? 'AUD' : env.EBAY_CURRENCY || 'USD';
  const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString('base64');
  const tokens = {};

  async function token(kind) {
    const t = tokens[kind];
    if (t && t.expires > Date.now() + 60_000) return t.value;
    const body = kind === 'user'
      ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.EBAY_REFRESH_TOKEN, scope: USER_SCOPES })
      : new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
    const res = await fetch(`${base}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`eBay OAuth failed (${res.status}): ${json.error_description || JSON.stringify(json)}`);
    tokens[kind] = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  async function rest(method, path, { body, auth = 'user', headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token(auth)}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-AU',
        'Accept-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = json.errors?.map((e) => e.longMessage || e.message).join('; ') || text;
      throw new Error(`eBay ${method} ${path.split('?')[0]} failed (${res.status}): ${msg}`);
    }
    return { json, location: res.headers.get('location') };
  }

  async function trading(callName, innerXml) {
    const res = await fetch(`${base}/ws/api.dll`, {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': SITE_IDS[marketplace] ?? '15',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
        'X-EBAY-API-IAF-TOKEN': await token('user'),
        'Content-Type': 'text/xml',
      },
      body: `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">${innerXml}</${callName}Request>`,
    });
    const xml = await res.text();
    if (!res.ok || xmlTag(xml, 'Ack') === 'Failure') {
      throw new Error(`eBay ${callName} failed: ${xmlTag(xml, 'LongMessage') || xml.slice(0, 300)}`);
    }
    return xml;
  }

  async function offerFor(sku) {
    const { json } = await rest('GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplace}`);
    const offer = json.offers?.[0];
    if (!offer) throw new Error(`No offer found for SKU ${sku}`);
    return offer;
  }

  function toListing(item, offer) {
    return {
      sku: item.sku,
      offerId: offer?.offerId,
      listingId: offer?.listing?.listingId,
      title: item.product?.title,
      description: offer?.listingDescription || item.product?.description,
      price: Number(offer?.pricingSummary?.price?.value),
      quantity: item.availability?.shipToLocationAvailability?.quantity,
      imageUrls: item.product?.imageUrls || [],
      url: offer?.listing?.listingId ? `https://www.ebay.com.au/itm/${offer.listing.listingId}` : undefined,
      categoryId: offer?.categoryId,
      status: offer?.status,
    };
  }

  // Fields accepted by updateOffer (PUT replaces the whole offer).
  const OFFER_FIELDS = ['availableQuantity', 'categoryId', 'listingDescription', 'listingDuration', 'listingPolicies',
    'merchantLocationKey', 'pricingSummary', 'quantityLimitPerBuyer', 'secondaryCategoryId', 'storeCategoryNames', 'tax',
    'includeCatalogProductDetails', 'hideBuyerDetails', 'lotSize', 'regulatory'];
  const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

  const listingCache = new Map();

  return {
    mode,

    async listListings() {
      const out = [];
      for (let offset = 0; ; offset += 100) {
        const { json } = await rest('GET', `/sell/inventory/v1/inventory_item?limit=100&offset=${offset}`);
        for (const item of json.inventoryItems || []) {
          const offer = await offerFor(item.sku).catch(() => null);
          const listing = toListing(item, offer);
          listingCache.set(item.sku, listing);
          out.push(listing);
        }
        if (!json.inventoryItems || out.length >= (json.total ?? 0)) break;
      }
      return out;
    },

    // One-off: convert listings made on ebay.com.au into Inventory API listings.
    async migrateListings(listingIds) {
      const results = [];
      for (let i = 0; i < listingIds.length; i += 5) {
        const { json } = await rest('POST', '/sell/inventory/v1/bulk_migrate_listing', {
          body: { requests: listingIds.slice(i, i + 5).map((listingId) => ({ listingId })) },
        });
        for (const r of json.responses || []) {
          results.push({
            listingId: r.listingId,
            ok: r.statusCode === 200,
            skus: r.inventoryItems?.map((it) => it.sku) || [],
            errors: r.errors?.map((e) => e.longMessage || e.message) || [],
          });
        }
      }
      return results;
    },

    async getListing(sku) {
      const { json: item } = await rest('GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
      const listing = toListing({ ...item, sku }, await offerFor(sku));
      listingCache.set(sku, listing);
      return listing;
    },

    async updatePrice(sku, price) {
      const offer = await offerFor(sku);
      const { json } = await rest('POST', '/sell/inventory/v1/bulk_update_price_quantity', {
        body: { requests: [{ sku, offers: [{ offerId: offer.offerId, price: { value: price.toFixed(2), currency } }] }] },
      });
      const r = json.responses?.[0];
      if (r && r.statusCode >= 400) throw new Error(`Price update failed: ${JSON.stringify(r.errors)}`);
      return { sku, price };
    },

    async updateListing(sku, { title, description }) {
      if (title) {
        const { json: item } = await rest('GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
        item.product = { ...item.product, title };
        if (description) item.product.description = description;
        await rest('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { body: item });
      }
      if (description) {
        const offer = await offerFor(sku);
        await rest('PUT', `/sell/inventory/v1/offer/${offer.offerId}`, {
          body: { ...pick(offer, OFFER_FIELDS), listingDescription: description },
        });
      }
      return this.getListing(sku);
    },

    async createListing({ sku, title, description, price, quantity, categoryId, imageUrls = [], aspects = {} }) {
      for (const k of ['EBAY_FULFILLMENT_POLICY_ID', 'EBAY_PAYMENT_POLICY_ID', 'EBAY_RETURN_POLICY_ID', 'EBAY_LOCATION_KEY']) {
        if (!env[k]) throw new Error(`${k} must be set in .env to create listings.`);
      }
      if (!imageUrls.length) throw new Error('At least one image URL is required to publish a listing.');
      await rest('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
        body: {
          condition: 'NEW',
          availability: { shipToLocationAvailability: { quantity } },
          product: { title, description, imageUrls, aspects },
        },
      });
      const { json: created } = await rest('POST', '/sell/inventory/v1/offer', {
        body: {
          sku, marketplaceId: marketplace, format: 'FIXED_PRICE', availableQuantity: quantity, categoryId,
          listingDescription: description,
          listingPolicies: {
            fulfillmentPolicyId: env.EBAY_FULFILLMENT_POLICY_ID,
            paymentPolicyId: env.EBAY_PAYMENT_POLICY_ID,
            returnPolicyId: env.EBAY_RETURN_POLICY_ID,
          },
          merchantLocationKey: env.EBAY_LOCATION_KEY,
          pricingSummary: { price: { value: price.toFixed(2), currency } },
        },
      });
      const { json: published } = await rest('POST', `/sell/inventory/v1/offer/${created.offerId}/publish`);
      return { sku, offerId: created.offerId, listingId: published.listingId, title, price, quantity };
    },

    async listOrders({ days = 7 } = {}) {
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const filter = encodeURIComponent(`creationdate:[${since}..]`);
      const { json } = await rest('GET', `/sell/fulfillment/v1/order?filter=${filter}&limit=200`);
      return (json.orders || []).map((o) => ({
        orderId: o.orderId,
        createdAt: o.creationDate,
        buyer: o.buyer?.username,
        status: o.orderFulfillmentStatus,
        total: Number(o.pricingSummary?.total?.value),
        items: o.lineItems?.map((li) => ({ sku: li.sku, title: li.title, quantity: li.quantity })),
      }));
    },

    async listMessages({ days = 7 } = {}) {
      const end = new Date();
      const start = new Date(end - days * 86400_000);
      const xml = await trading('GetMemberMessages',
        `<MailMessageType>All</MailMessageType><MessageStatus>Unanswered</MessageStatus>` +
        `<StartCreationTime>${start.toISOString()}</StartCreationTime><EndCreationTime>${end.toISOString()}</EndCreationTime>`);
      return xmlAll(xml, 'MemberMessageExchange').map((ex) => {
        const q = xmlTag(ex, 'Question') || '';
        return {
          messageId: xmlTag(q, 'MessageID'),
          from: xmlTag(q, 'SenderID'),
          subject: xmlTag(q, 'Subject'),
          body: xmlTag(q, 'Body'),
          itemId: xmlTag(xmlTag(ex, 'Item') || '', 'ItemID'),
          receivedAt: xmlTag(ex, 'CreationDate'),
          replied: false,
        };
      });
    },

    async getMessage(messageId) {
      const m = (await this.listMessages({ days: 30 })).find((x) => x.messageId === messageId);
      if (!m) throw new Error(`No unanswered message ${messageId}`);
      return m;
    },

    async replyToMessage(messageId, text) {
      const m = await this.getMessage(messageId);
      await trading('AddMemberMessageRTQ',
        `<ItemID>${xmlEscape(m.itemId)}</ItemID><MemberMessage><Body>${xmlEscape(text)}</Body>` +
        `<ParentMessageID>${xmlEscape(messageId)}</ParentMessageID><RecipientID>${xmlEscape(m.from)}</RecipientID></MemberMessage>`);
      return { messageId, sent: true };
    },

    async trafficReport({ days = 30 } = {}) {
      const end = new Date();
      const start = new Date(end - days * 86400_000);
      const metrics = ['LISTING_IMPRESSION_TOTAL', 'LISTING_VIEWS_TOTAL', 'TRANSACTION', 'SALES_CONVERSION_RATE'];
      const filter = encodeURIComponent(`marketplace_ids:{${marketplace}},date_range:[${yyyymmdd(start)}..${yyyymmdd(end)}]`);
      const { json } = await rest('GET',
        `/sell/analytics/v1/traffic_report?dimension=LISTING&metric=${metrics.join(',')}&filter=${filter}`);
      const keys = json.header?.metrics?.map((m) => m.key) || metrics;
      const bySku = new Map([...listingCache.values()].map((l) => [l.listingId, l]));
      return (json.records || []).map((r) => {
        const listingId = r.dimensionValues?.[0]?.value;
        const v = Object.fromEntries(keys.map((k, i) => [k, Number(r.metricValues?.[i]?.value ?? 0)]));
        const l = bySku.get(listingId);
        return {
          listingId, sku: l?.sku, title: l?.title, price: l?.price,
          impressions: v.LISTING_IMPRESSION_TOTAL, views: v.LISTING_VIEWS_TOTAL, sold: v.TRANSACTION,
          conversionPct: v.SALES_CONVERSION_RATE,
        };
      });
    },

    async searchMarket(query) {
      const { json } = await rest('GET', `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=20`, { auth: 'app' });
      return (json.itemSummaries || []).map((i) => ({
        title: i.title,
        price: Number(i.price?.value),
        shipping: Number(i.shippingOptions?.[0]?.shippingCost?.value ?? NaN),
        seller: i.seller?.username,
        condition: i.condition,
        url: i.itemWebUrl,
      }));
    },

    async createMarkdownSale({ name, skus, discountPct, startDate, endDate }) {
      const listingIds = await Promise.all(skus.map(async (s) => (listingCache.get(s) || await this.getListing(s)).listingId));
      const { location } = await rest('POST', '/sell/marketing/v1/item_price_markdown', {
        body: {
          name, marketplaceId: marketplace, startDate, endDate, promotionStatus: 'SCHEDULED',
          applyFreeShipping: false,
          selectedInventoryDiscounts: [{
            ruleOrder: 1,
            discountBenefit: { percentageOffItem: String(discountPct) },
            inventoryCriterion: { inventoryCriterionType: 'INVENTORY_BY_VALUE', listingIds },
          }],
        },
      });
      return { promotionId: location?.split('/').pop(), name, skus, discountPct, startDate, endDate };
    },

    async listPromotions() {
      const { json } = await rest('GET', `/sell/marketing/v1/promotion?marketplace_id=${marketplace}&limit=50`);
      return (json.promotions || []).map((p) => ({
        promotionId: p.promotionId, name: p.name, type: p.promotionType, status: p.promotionStatus,
        startDate: p.startDate, endDate: p.endDate,
      }));
    },

    async promoteListings({ skus, adRatePct }) {
      const listingIds = await Promise.all(skus.map(async (s) => (listingCache.get(s) || await this.getListing(s)).listingId));
      const { location } = await rest('POST', '/sell/marketing/v1/ad_campaign', {
        body: {
          campaignName: `Claudius ${new Date().toISOString().slice(0, 10)} ${Date.now() % 10000}`,
          marketplaceId: marketplace,
          startDate: new Date().toISOString(),
          fundingStrategy: { fundingModel: 'COST_PER_SALE', bidPercentage: adRatePct.toFixed(1) },
        },
      });
      const campaignId = location?.split('/').pop();
      await rest('POST', `/sell/marketing/v1/ad_campaign/${campaignId}/bulk_create_ads_by_listing_id`, {
        body: { requests: listingIds.map((listingId) => ({ listingId, bidPercentage: adRatePct.toFixed(1) })) },
      });
      return { campaignId, skus, adRatePct, status: 'RUNNING' };
    },
  };
}
