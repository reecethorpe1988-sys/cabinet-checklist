// state.js — Claudius's on-disk memory: price baselines, daily counters,
// an append-only action log, owner escalations, and free-form notes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.CLAUDIUS_DATA_DIR || path.join(ROOT, 'data');

const STATE_FILE = () => path.join(DATA_DIR, 'state.json');
const ACTIONS_FILE = () => path.join(DATA_DIR, 'actions.jsonl');
const ESCALATIONS_FILE = () => path.join(DATA_DIR, 'escalations.md');
const NOTES_FILE = () => path.join(DATA_DIR, 'notes.md');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function loadState() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    return { baselines: {}, priceChanges: {}, lastRun: null };
  }
}

export function saveState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2));
}

// Remember the first price Claudius ever saw for a SKU, so discounts are
// always measured against the owner's original price, not a drifting one.
export function recordBaseline(state, sku, price) {
  if (state.baselines[sku] === undefined) state.baselines[sku] = price;
  return state.baselines[sku];
}

// Price at the start of today for a SKU (for the per-day change cap).
export function startOfDayPrice(state, sku, currentPrice) {
  for (const d of Object.keys(state.priceChanges)) if (d !== today()) delete state.priceChanges[d];
  const day = state.priceChanges[today()] ||= {};
  if (day[sku] === undefined) day[sku] = currentPrice;
  return day[sku];
}

export function logAction(entry) {
  ensureDir();
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(ACTIONS_FILE(), line + '\n');
}

export function readActions({ sinceHours = 24 } = {}) {
  try {
    const cutoff = Date.now() - sinceHours * 3600_000;
    return fs.readFileSync(ACTIONS_FILE(), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((a) => Date.parse(a.at) >= cutoff);
  } catch {
    return [];
  }
}

export function escalate({ subject, details, urgency = 'normal' }) {
  ensureDir();
  const block = `\n## [${urgency.toUpperCase()}] ${subject}\n_${new Date().toISOString()}_\n\n${details}\n`;
  fs.appendFileSync(ESCALATIONS_FILE(), block);
  logAction({ type: 'escalation', subject, urgency });
}

export function readNotes() {
  try {
    return fs.readFileSync(NOTES_FILE(), 'utf8');
  } catch {
    return '';
  }
}

export function appendNote(note) {
  ensureDir();
  fs.appendFileSync(NOTES_FILE(), `- ${today()}: ${note.trim()}\n`);
}

// A snapshot of the store's listings for other agents (e.g. the Instagram
// agent) to read without needing their own eBay access.
export function writeCatalog(listings, promotions) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    listings: listings.map(({ sku, title, price, quantity, url, imageUrls, description }) =>
      ({ sku, title, price, quantity, url, imageUrls, description })),
    promotions: Array.isArray(promotions) ? promotions : [],
  }, null, 2));
}
