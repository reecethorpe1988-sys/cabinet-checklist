// guardrails.js — hard limits enforced in code, not in the prompt.
// Claudius runs autonomously; these checks are what keep a bad decision
// (or a confused model) from costing real money. Every check returns
// { ok: true } or { ok: false, reason } so the model learns why it was blocked.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './state.js';

export function isPaused() {
  return process.env.CLAUDIUS_PAUSED === '1' || fs.existsSync(path.join(ROOT, 'STOP'));
}

const round2 = (n) => Math.round(n * 100) / 100;

// The lowest price Claudius may ever set for a SKU.
export function priceFloor({ sku, baseline, config }) {
  const g = config.guardrails;
  const floors = [g.absoluteMinPrice];
  const cost = config.products?.[sku]?.cost;
  if (typeof cost === 'number') floors.push(cost * (1 + g.minMarginPct / 100));
  if (typeof baseline === 'number') floors.push(baseline * (1 - g.maxDropBelowBaselinePct / 100));
  return round2(Math.max(...floors));
}

export function checkPriceChange({ sku, newPrice, startOfDay, baseline, changesThisRun, config }) {
  const g = config.guardrails;
  if (!(typeof newPrice === 'number' && Number.isFinite(newPrice) && newPrice > 0)) {
    return { ok: false, reason: 'Price must be a positive number.' };
  }
  if (changesThisRun >= g.maxPriceChangesPerRun) {
    return { ok: false, reason: `Limit of ${g.maxPriceChangesPerRun} price changes per run reached.` };
  }
  const floor = priceFloor({ sku, baseline, config });
  if (newPrice < floor) {
    return { ok: false, reason: `$${newPrice} is below this SKU's floor of $${floor}.` };
  }
  const changePct = (Math.abs(newPrice - startOfDay) / startOfDay) * 100;
  if (changePct > g.maxPriceChangePctPerDay + 1e-9) {
    return {
      ok: false,
      reason: `That is a ${changePct.toFixed(1)}% move from today's opening price of $${startOfDay}; the daily limit is ${g.maxPriceChangePctPerDay}%.`,
    };
  }
  return { ok: true };
}

export function checkPromotion({ discountPct, days, config }) {
  const g = config.guardrails;
  if (!(discountPct > 0 && discountPct <= g.maxDiscountPct)) {
    return { ok: false, reason: `Discount must be between 1% and ${g.maxDiscountPct}%.` };
  }
  if (!(days >= 1 && days <= g.maxPromotionDays)) {
    return { ok: false, reason: `Promotions can run 1–${g.maxPromotionDays} days.` };
  }
  return { ok: true };
}

export function checkAdRate({ adRatePct, config }) {
  const max = config.guardrails.maxAdRatePct;
  if (!(adRatePct >= 2 && adRatePct <= max)) {
    return { ok: false, reason: `Ad rate must be between 2% (eBay minimum) and ${max}%.` };
  }
  return { ok: true };
}

const hasAny = (text, words) => {
  const t = text.toLowerCase();
  return words.filter((w) => t.includes(w.toLowerCase()));
};

// Does a buyer's message need the owner rather than Claudius?
export function needsEscalation(buyerText, config) {
  return hasAny(buyerText || '', config.guardrails.escalationKeywords);
}

export function checkBuyerReply({ reply, buyerText, repliesThisRun, config }) {
  const g = config.guardrails;
  if (!reply || reply.trim().length < 5) return { ok: false, reason: 'Reply is empty.' };
  if (reply.length > 2000) return { ok: false, reason: 'Reply is over 2000 characters.' };
  if (repliesThisRun >= g.maxBuyerRepliesPerRun) {
    return { ok: false, reason: `Limit of ${g.maxBuyerRepliesPerRun} buyer replies per run reached.` };
  }
  if (!g.allowRefundsOrMoneyPromises) {
    const banned = hasAny(reply, g.replyBlocklist);
    if (banned.length) {
      return {
        ok: false,
        reason: `Reply contains blocked terms (${banned.join(', ')}). Money, refunds, off-eBay contact and guarantees are the owner's call: use escalate_to_owner instead.`,
      };
    }
    if (/\$\s?\d/.test(reply)) {
      return { ok: false, reason: 'Replies may not quote dollar amounts; point buyers to the listing price or escalate.' };
    }
  }
  const flagged = needsEscalation(buyerText, config);
  if (flagged.length) {
    return {
      ok: false,
      reason: `Buyer message mentions ${flagged.join(', ')}. This must go to the owner via escalate_to_owner, not an automatic reply.`,
    };
  }
  return { ok: true };
}

export function checkNewListing({ title, price, sku, createdThisRun, config }) {
  const g = config.guardrails;
  if (createdThisRun >= g.maxListingsCreatedPerRun) {
    return { ok: false, reason: `Limit of ${g.maxListingsCreatedPerRun} new listings per run reached.` };
  }
  if (!title || title.length > 80) return { ok: false, reason: 'eBay titles must be 1–80 characters.' };
  const floor = priceFloor({ sku, baseline: undefined, config });
  if (!(price >= floor)) return { ok: false, reason: `Price must be at least $${floor}.` };
  return { ok: true };
}
