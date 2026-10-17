import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as g from '../src/guardrails.js';

const config = JSON.parse(fs.readFileSync(new URL('../claudius.config.json', import.meta.url)));

test('price floor uses cost + margin when it is the highest floor', () => {
  // YETI-BOOT cost 3.20 * 1.4 = 4.48; baseline 12.95 * 0.7 = 9.07 is higher
  assert.equal(g.priceFloor({ sku: 'YETI-BOOT', baseline: 12.95, config }), 9.07);
  assert.equal(g.priceFloor({ sku: 'YETI-BOOT', baseline: undefined, config }), 4.48);
  assert.equal(g.priceFloor({ sku: 'UNKNOWN', baseline: undefined, config }), 3);
});

test('price changes respect floor, daily cap and run cap', () => {
  const base = { sku: 'YETI-BOOT', startOfDay: 12.95, baseline: 12.95, changesThisRun: 0, config };
  assert.equal(g.checkPriceChange({ ...base, newPrice: 11.95 }).ok, true);
  assert.equal(g.checkPriceChange({ ...base, newPrice: 9.0 }).ok, false); // below floor 9.07
  assert.match(g.checkPriceChange({ ...base, newPrice: 10.0 }).reason, /daily limit/); // -22.8%
  assert.match(g.checkPriceChange({ ...base, newPrice: 15.5 }).reason, /daily limit/); // +19.7%
  assert.match(g.checkPriceChange({ ...base, newPrice: 12.5, changesThisRun: 10 }).reason, /per run/);
  assert.equal(g.checkPriceChange({ ...base, newPrice: NaN }).ok, false);
});

test('buyer replies: blocks money talk and escalation topics', () => {
  const ok = { buyerText: 'Will it fit a 26oz?', repliesThisRun: 0, config };
  assert.equal(g.checkBuyerReply({ ...ok, reply: 'Yes, it fits the 26oz Rambler snugly. Cheers!' }).ok, true);
  assert.equal(g.checkBuyerReply({ ...ok, reply: 'I can do it for $10 if you like' }).ok, false);
  assert.equal(g.checkBuyerReply({ ...ok, reply: 'Happy to give you a discount on two' }).ok, false);
  assert.equal(g.checkBuyerReply({ ...ok, reply: 'Message me on WhatsApp' }).ok, false);
  const refund = g.checkBuyerReply({ ...ok, buyerText: 'Arrived broken, I want a refund', reply: 'So sorry to hear that, let me look into it.' });
  assert.match(refund.reason, /escalate_to_owner/);
});

test('promotion and ad rate limits', () => {
  assert.equal(g.checkPromotion({ discountPct: 10, days: 7, config }).ok, true);
  assert.equal(g.checkPromotion({ discountPct: 40, days: 7, config }).ok, false);
  assert.equal(g.checkPromotion({ discountPct: 10, days: 30, config }).ok, false);
  assert.equal(g.checkAdRate({ adRatePct: 4, config }).ok, true);
  assert.equal(g.checkAdRate({ adRatePct: 12, config }).ok, false);
});

test('new listings: title length and run cap', () => {
  const base = { title: 'Ooshies Display Stand Holds 24', price: 12, sku: 'NEW', createdThisRun: 0, config };
  assert.equal(g.checkNewListing(base).ok, true);
  assert.equal(g.checkNewListing({ ...base, title: 'x'.repeat(81) }).ok, false);
  assert.equal(g.checkNewListing({ ...base, createdThisRun: 3 }).ok, false);
});
