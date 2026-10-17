// mock.js — a simulated copy of the rt3d-bbz store, so Claudius can be run
// and tested end to end before any eBay keys exist. Changes persist to
// data/mock-store.json; delete that file to reset.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../state.js';

const FILE = () => path.join(DATA_DIR, 'mock-store.json');

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

function seed() {
  const l = (sku, title, price, quantity, categoryId, views, impressions, sold, description) => ({
    sku, offerId: `OFFER-${sku}`, listingId: `MOCK-${sku}`, title, price, quantity, categoryId,
    description, stats: { views, impressions, sold },
  });
  return {
    listings: [
      l('YETI-BOOT', 'TPU Bumper Boot for YETI Rambler Bottles 18-64oz Non-Slip Silicone-Feel', 12.95, 25, '20605', 410, 9800, 31,
        'Protect the base of your YETI Rambler from dings and scratches. Flexible TPU, printed in Australia.'),
      l('OOSH-STAND-42', 'Ooshies Display Stand Holds Full Set of 42 3D Printed', 15.0, 12, '2617', 260, 5400, 18,
        'Show off your whole Ooshies collection. Holds 42 figures, stable tiered design.'),
      l('OOSH-LABEL', 'Ooshies Display Stand Clip On Label', 3.99, 40, '2617', 95, 3100, 9,
        'Clip-on name label for Ooshies display stands.'),
      l('PROP-STATION-3', 'Set of 3 Wall Mounted Plant Propagation Stations Test Tube', 24.95, 8, '20518', 180, 4200, 6,
        'Three wall-mounted propagation stations with glass test tubes. Great for cuttings.'),
      l('TREAD-BOTTLE', 'Treadmill Bottle Holder Clip On Drink Cup Holder', 24.95, 10, '15273', 140, 2600, 4,
        'Clip-on bottle holder for most treadmill handrails.'),
      l('HP-KNIT-FIG', 'Harry Potter 3D Printed Figure Knitted Style', 35.0, 3, '1345', 60, 1900, 1,
        'Knitted-texture style figure, 3D printed and finished by hand.'),
      l('MONSTERA-COASTER', '3D Printed Monstera Coaster Plant Set with Pot Holder', 32.95, 6, '20625', 75, 2300, 2,
        'Coasters shaped like monstera leaves that sit in a mini pot. Conversation starter for any table.'),
    ],
    orders: [
      { orderId: 'MOCK-ORD-1001', createdAt: daysAgo(1), buyer: 'sam_k***', sku: 'YETI-BOOT', quantity: 2, total: 25.9, status: 'NOT_STARTED' },
      { orderId: 'MOCK-ORD-1000', createdAt: daysAgo(3), buyer: 'jules.m***', sku: 'OOSH-STAND-42', quantity: 1, total: 15.0, status: 'FULFILLED' },
    ],
    messages: [
      { messageId: 'MSG-1', from: 'outdoorsy_dan', itemId: 'MOCK-YETI-BOOT', receivedAt: daysAgo(0.2), replied: false,
        subject: 'Fit question', body: 'Hi, will this fit the 26oz Rambler bottle? Thanks' },
      { messageId: 'MSG-2', from: 'kidsmum2019', itemId: 'MOCK-OOSH-STAND-42', receivedAt: daysAgo(0.5), replied: false,
        subject: 'Colours', body: 'Do you do this in pink or purple? My daughter would love it.' },
      { messageId: 'MSG-3', from: 'grumpy_g', itemId: 'MOCK-TREAD-BOTTLE', receivedAt: daysAgo(1), replied: false,
        subject: 'Arrived broken', body: 'The clip arrived broken. I want a refund.' },
    ],
    promotions: [],
    campaigns: [],
    sent: [],
  };
}

export function createMockStore() {
  let db;
  const load = () => {
    if (db) return db;
    try { db = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { db = seed(); save(); }
    return db;
  };
  const save = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(db, null, 2));
  };
  const find = (sku) => {
    const item = load().listings.find((x) => x.sku === sku);
    if (!item) throw new Error(`No listing with SKU ${sku}`);
    return item;
  };
  const pub = ({ stats, ...rest }) => rest;

  return {
    mode: 'mock',

    async listListings() {
      return load().listings.map(pub);
    },

    async migrateListings(listingIds) {
      return listingIds.map((listingId) => ({ listingId, ok: true, skus: [`MOCK-${listingId}`], errors: [] }));
    },

    async getListing(sku) {
      return pub(find(sku));
    },

    async updatePrice(sku, price) {
      find(sku).price = price;
      save();
      return { sku, price };
    },

    async updateListing(sku, { title, description }) {
      const item = find(sku);
      if (title) item.title = title;
      if (description) item.description = description;
      save();
      return pub(item);
    },

    async createListing({ sku, title, description, price, quantity, categoryId }) {
      if (load().listings.some((x) => x.sku === sku)) throw new Error(`SKU ${sku} already exists`);
      const item = { sku, offerId: `OFFER-${sku}`, listingId: `MOCK-${sku}`, title, description, price, quantity, categoryId,
        stats: { views: 0, impressions: 0, sold: 0 } };
      load().listings.push(item);
      save();
      return pub(item);
    },

    async listOrders({ days = 7 } = {}) {
      const cutoff = Date.now() - days * 86400_000;
      return load().orders.filter((o) => Date.parse(o.createdAt) >= cutoff);
    },

    async listMessages({ unrepliedOnly = true } = {}) {
      return load().messages.filter((m) => !unrepliedOnly || !m.replied);
    },

    async getMessage(messageId) {
      const m = load().messages.find((x) => x.messageId === messageId);
      if (!m) throw new Error(`No message ${messageId}`);
      return m;
    },

    async replyToMessage(messageId, text) {
      const m = await this.getMessage(messageId);
      m.replied = true;
      load().sent.push({ messageId, to: m.from, text, at: new Date().toISOString() });
      save();
      return { messageId, sent: true };
    },

    async trafficReport() {
      return load().listings.map(({ sku, listingId, title, price, stats }) => ({
        sku, listingId, title, price, ...stats,
        conversionPct: stats.views ? Math.round((stats.sold / stats.views) * 1000) / 10 : 0,
      }));
    },

    async searchMarket(query) {
      // Pretend competitors priced around our own listing for the same query.
      const ours = load().listings.find((x) => x.title.toLowerCase().includes(query.toLowerCase().split(' ')[0]));
      const base = ours?.price ?? 20;
      return [0.85, 0.95, 1.0, 1.1, 1.25].map((f, i) => ({
        title: `${query} (competitor ${i + 1})`, price: Math.round(base * f * 100) / 100,
        shipping: i % 2 ? 0 : 5.5, seller: `seller_${i + 1}`, condition: 'New',
      }));
    },

    async createMarkdownSale({ name, skus, discountPct, startDate, endDate }) {
      const promo = { promotionId: `PROMO-${load().promotions.length + 1}`, name, skus, discountPct, startDate, endDate, status: 'SCHEDULED' };
      load().promotions.push(promo);
      save();
      return promo;
    },

    async listPromotions() {
      return load().promotions;
    },

    async promoteListings({ skus, adRatePct }) {
      const campaign = { campaignId: `CAMP-${load().campaigns.length + 1}`, skus, adRatePct, status: 'RUNNING' };
      load().campaigns.push(campaign);
      save();
      return campaign;
    },
  };
}
