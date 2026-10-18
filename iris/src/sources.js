// sources.js — what Iris can post about: Claudius's eBay catalog and recent
// activity, the owner's Facebook Marketplace items, and photos in photos/.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PHOTOS_DIR, readJson } from './state.js';

const claudiusDir = () => path.resolve(ROOT, process.env.CLAUDIUS_DIR || '../claudius');

export function readCatalog() {
  return readJson(path.join(claudiusDir(), 'data', 'catalog.json'), null);
}

function readClaudiusActions(days) {
  const cutoff = Date.now() - days * 86400_000;
  try {
    return fs.readFileSync(path.join(claudiusDir(), 'data', 'actions.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((a) => a.type === 'action' && Date.parse(a.at) >= cutoff);
  } catch {
    return [];
  }
}

// eBay sales Claudius has scheduled that are running now.
export function activeSales(now = Date.now()) {
  return readClaudiusActions(30)
    .filter((a) => a.tool === 'create_sale')
    .map((a) => ({ name: a.name, skus: a.skus, discountPct: a.discountPct, endsAt: new Date(Date.parse(a.at) + a.days * 86400_000).toISOString() }))
    .filter((s) => Date.parse(s.endsAt) > now);
}

// Things worth posting about from the last week of Claudius's work.
export function recentStoreEvents(days = 7) {
  return readClaudiusActions(days)
    .filter((a) => ['create_listing', 'create_sale', 'set_price'].includes(a.tool))
    .filter((a) => a.tool !== 'set_price' || a.to < a.from)
    .map((a) => ({
      at: a.at,
      event: a.tool === 'create_listing' ? 'new_listing' : a.tool === 'create_sale' ? 'sale_started' : 'price_drop',
      skus: a.skus || [a.sku],
      ...(a.tool === 'create_sale' && { name: a.name, discountPct: a.discountPct, days: a.days }),
      ...(a.tool === 'set_price' && { from: a.from, to: a.to }),
      ...(a.tool === 'create_listing' && { title: a.title, price: a.price }),
    }));
}

// Social drafts Claudius already wrote; Iris can polish and schedule them.
export function claudiusSocialDrafts(days = 7) {
  const dir = path.join(claudiusDir(), 'outbox');
  try {
    const cutoff = Date.now() - days * 86400_000;
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
      .map((f) => ({ file: f, stat: fs.statSync(path.join(dir, f)) }))
      .filter((f) => f.stat.mtimeMs >= cutoff)
      .map((f) => ({ file: f.file, text: fs.readFileSync(path.join(dir, f.file), 'utf8').slice(0, 1500) }));
  } catch {
    return [];
  }
}

export function readMarketplace() {
  return readJson(process.env.IRIS_MARKETPLACE_FILE || path.join(ROOT, 'marketplace.json'), []);
}

const PHOTO_EXT = /\.(jpe?g|png|webp|heic)$/i;

export function listLocalPhotos() {
  try {
    return fs.readdirSync(PHOTOS_DIR).filter((f) => PHOTO_EXT.test(f)).map((f) => {
      const st = fs.statSync(path.join(PHOTOS_DIR, f));
      return { file: f, addedAt: st.mtime.toISOString(), sizeKb: Math.round(st.size / 1024) };
    }).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  } catch {
    return [];
  }
}

// Prices a caption may quote for the given featured items.
export function pricesFor({ skus = [], marketplaceIds = [] }) {
  const catalog = readCatalog();
  const sales = activeSales();
  const prices = [];
  const discounts = [];
  for (const sku of skus) {
    const l = catalog?.listings?.find((x) => x.sku === sku);
    if (!l) continue;
    prices.push(l.price);
    for (const s of sales.filter((s) => s.skus.includes(sku))) {
      prices.push(Math.round(l.price * (1 - s.discountPct / 100) * 100) / 100);
      discounts.push(s.discountPct);
    }
  }
  for (const id of marketplaceIds) {
    const m = readMarketplace().find((x) => x.id === id);
    if (m) prices.push(Number(m.price));
  }
  return { prices, discounts };
}
