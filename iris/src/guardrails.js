// guardrails.js — hard limits on what Iris can put on your Instagram,
// enforced in code. Each check returns { ok: true } or { ok: false, reason }.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './state.js';
import { localDate } from './time.js';

export function isPaused() {
  return process.env.IRIS_PAUSED === '1' || fs.existsSync(path.join(ROOT, 'STOP'));
}

const ACTIVE = new Set(['draft', 'approved', 'published']);

// Every dollar amount in a caption must be a real current price (or a real
// sale price) of something the post features, so Iris can't invent a deal.
export function checkCaption({ caption, allowedPrices, allowedDiscounts = [], config }) {
  const g = config.guardrails;
  if (!caption || caption.trim().length < 10) return { ok: false, reason: 'Caption is empty or too short.' };
  if (caption.length > g.maxCaptionChars) {
    return { ok: false, reason: `Caption is ${caption.length} characters; the limit is ${g.maxCaptionChars}.` };
  }
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) || [];
  if (tags.length > g.maxHashtags) {
    return { ok: false, reason: `${tags.length} hashtags; the limit is ${g.maxHashtags}.` };
  }
  const lower = caption.toLowerCase();
  const banned = g.bannedPhrases.filter((p) => lower.includes(p.toLowerCase()));
  if (banned.length) return { ok: false, reason: `Caption contains banned phrases: ${banned.join(', ')}.` };

  const amounts = [...caption.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  const unknown = amounts.filter((a) => !allowedPrices.some((p) => Math.abs(p - a) < 0.01));
  if (unknown.length) {
    const known = allowedPrices.length ? allowedPrices.map((p) => `$${p.toFixed(2)}`).join(', ') : 'none (no featured items)';
    return { ok: false, reason: `Caption mentions ${unknown.map((a) => `$${a}`).join(', ')}, which is not a current price of a featured item. Valid prices: ${known}.` };
  }
  const pct = [...caption.matchAll(/(\d{1,2})\s?%\s?off/gi)].map((m) => Number(m[1]));
  if (pct.length && !pct.every((p) => allowedDiscounts.includes(p))) {
    return { ok: false, reason: `Caption mentions ${pct.join('%, ')}% off, but no featured item has an active sale at that discount.` };
  }
  return { ok: true };
}

export function checkImages(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length < 1 || imageUrls.length > 10) {
    return { ok: false, reason: 'A post needs 1 to 10 images.' };
  }
  const bad = imageUrls.filter((u) => !/^https:\/\//.test(u));
  if (bad.length) {
    return { ok: false, reason: `Instagram needs public https image URLs. For a local photo, call host_photo first. Bad: ${bad.join(', ')}` };
  }
  return { ok: true };
}

// Posting cadence: future, not too far ahead, a daily cap and a minimum gap.
export function checkSchedule({ postAt, queue, ignoreId, now = new Date(), config }) {
  const p = config.publishing;
  const t = new Date(postAt);
  if (Number.isNaN(t.getTime())) return { ok: false, reason: `"${postAt}" is not a valid date/time.` };
  if (t - now < 5 * 60_000) return { ok: false, reason: 'Post time must be at least 5 minutes in the future.' };
  if (t - now > p.maxDaysAhead * 86400_000) return { ok: false, reason: `Posts can be scheduled at most ${p.maxDaysAhead} days ahead.` };

  const others = queue.filter((q) => ACTIVE.has(q.status) && q.id !== ignoreId);
  const day = localDate(t, p.timezone);
  const sameDay = others.filter((q) => localDate(new Date(q.publishedAt || q.postAt), p.timezone) === day);
  if (sameDay.length >= p.maxPostsPerDay) {
    return { ok: false, reason: `${day} already has ${sameDay.length} post(s); the limit is ${p.maxPostsPerDay} per day.` };
  }
  const gapMs = p.minHoursBetweenPosts * 3600_000;
  const clash = others.find((q) => Math.abs(new Date(q.publishedAt || q.postAt) - t) < gapMs);
  if (clash) return { ok: false, reason: `Too close to ${clash.id}; keep at least ${p.minHoursBetweenPosts} hours between posts.` };
  return { ok: true };
}
