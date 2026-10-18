// tools.js — what Iris can do. Iris can draft and schedule posts, but only
// the owner can approve them (via the CLI) unless autoPublish is on.
import fs from 'node:fs';
import path from 'node:path';
import * as guard from './guardrails.js';
import { photoBlocks, hostPhoto } from './photos.js';
import { upcomingSlots, localDateTime } from './time.js';
import {
  readCatalog, activeSales, recentStoreEvents, claudiusSocialDrafts, readMarketplace, listLocalPhotos, pricesFor,
} from './sources.js';
import {
  OUTBOX_DIR, loadQueue, saveQueue, nextPostId, logAction, escalate, appendNote,
} from './state.js';

const str = (description) => ({ type: 'string', description });
const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const TOOLS = [
  {
    name: 'get_briefing',
    description: 'Everything to plan from: eBay catalog (from Claudius) with prices, stock and photo URLs; active eBay sales; new listings and price drops this week; Claudius\'s social drafts; Facebook Marketplace items; photos the owner added to photos/; the post queue; recent Instagram posts with engagement; and the next free posting slots. Call this first.',
    input_schema: obj({}),
  },
  {
    name: 'look_at_photo',
    description: 'See a photo before you post it or write about it: an https URL (e.g. an eBay listing photo) or a filename in photos/. Check it is sharp, well lit, shows the product clearly, and matches what your caption says.',
    input_schema: obj({ source: str('https URL or a filename from photos/') }),
  },
  {
    name: 'host_photo',
    description: 'Upload a photo from photos/ to public hosting as a JPEG and get its https URL. Instagram can only post from public URLs.',
    input_schema: obj({ filename: str('Filename in photos/') }),
  },
  {
    name: 'queue_post',
    description: 'Add a feed post (1 image, or a 2–10 image carousel) to the queue for a time slot. Checked in code: any $ price must be a real current or sale price of a featured item, any "% off" must match an active sale, banned phrases are rejected, max posts per day and min gap between posts apply.',
    input_schema: obj({
      image_urls: strs('Public https JPEG URLs, first image is the cover'),
      caption: str('Full caption including hashtags'),
      featured_skus: strs('eBay SKUs this post features ([] if none)'),
      marketplace_item_ids: strs('Facebook Marketplace item IDs this post features ([] if none)'),
      post_at: str('ISO 8601 time with offset, ideally one of the free slots from get_briefing'),
      reason: str('One sentence: why this post, why now'),
    }),
  },
  {
    name: 'revise_post',
    description: 'Change the caption and/or time of a queued post that has not been published. Re-runs every check. A revised approved post goes back to draft for the owner to re-approve (unless autoPublish is on).',
    input_schema: obj({ post_id: str('e.g. P004'), caption: str('New caption, or "" to keep'), post_at: str('New ISO time, or "" to keep') }),
  },
  {
    name: 'draft_marketplace_listing',
    description: 'Write ready-to-paste Facebook Marketplace listing text for an item (Meta has no API to post Marketplace listings, so the owner pastes it). Saved to outbox/.',
    input_schema: obj({
      item_id: str('ID from marketplace.json'),
      title: str('Listing title, under 100 characters'),
      category: str('Suggested Marketplace category'),
      description: str('Description: what it is, condition, size, pickup area'),
    }),
  },
  {
    name: 'escalate_to_owner',
    description: 'Ask the owner for something: a new photo or video you need, a fact you can\'t verify (colours, sizes), approval for an idea, or a problem.',
    input_schema: obj({
      subject: str('Short subject'),
      details: str('What you need and why'),
      urgency: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'urgent = needs a response today' },
    }),
  },
  {
    name: 'save_note',
    description: 'Save a lesson to long-term memory (e.g. "carousels showing the print process get 2x the saves"). Shown to you every run.',
    input_schema: obj({ note: str('The note') }),
  },
].map((t) => ({ ...t, strict: true }));

export function createToolContext({ instagram, config }) {
  return { instagram, config, counters: { queued: 0 } };
}

function summarizeQueue(queue, tz) {
  return queue.filter((q) => q.status !== 'rejected').slice(-20).map((q) => ({
    id: q.id, status: q.status, when: localDateTime(new Date(q.publishedAt || q.postAt), tz),
    postAt: q.postAt, featured: [...q.featuredSkus, ...q.marketplaceItemIds], caption: q.caption.slice(0, 120),
  }));
}

function validate({ caption, imageUrls, featuredSkus, marketplaceItemIds, postAt, queue, ignoreId, config }) {
  const { prices, discounts } = pricesFor({ skus: featuredSkus, marketplaceIds: marketplaceItemIds });
  for (const check of [
    guard.checkImages(imageUrls),
    guard.checkCaption({ caption, allowedPrices: prices, allowedDiscounts: discounts, config }),
    guard.checkSchedule({ postAt, queue, ignoreId, config }),
  ]) if (!check.ok) return check;
  const catalog = readCatalog();
  const unknownSkus = featuredSkus.filter((s) => !catalog?.listings?.some((l) => l.sku === s));
  if (unknownSkus.length) return { ok: false, reason: `Unknown SKUs: ${unknownSkus.join(', ')}.` };
  const soldOut = featuredSkus.filter((s) => catalog.listings.find((l) => l.sku === s)?.quantity === 0);
  if (soldOut.length) return { ok: false, reason: `Out of stock on eBay: ${soldOut.join(', ')}.` };
  const mp = readMarketplace();
  const badMp = marketplaceItemIds.filter((id) => mp.find((m) => m.id === id)?.status !== 'available');
  if (badMp.length) return { ok: false, reason: `Not available on Marketplace: ${badMp.join(', ')}.` };
  return { ok: true };
}

export async function executeTool(name, input, ctx) {
  const { instagram, config, counters } = ctx;
  const tz = config.publishing.timezone;
  const blocked = (reason) => {
    logAction({ type: 'blocked', tool: name, reason });
    return { error: `Blocked by guardrail: ${reason}` };
  };

  switch (name) {
    case 'get_briefing': {
      const queue = loadQueue();
      const catalog = readCatalog();
      const [recent, quota] = await Promise.all([
        instagram.recentPosts({ limit: 12 }).catch((e) => ({ error: e.message })),
        instagram.publishingQuota().catch(() => null),
      ]);
      const slots = upcomingSlots({ timeZone: tz, slots: config.publishing.postingSlots, count: 10 })
        .filter((t) => guard.checkSchedule({ postAt: t.toISOString(), queue, config }).ok)
        .slice(0, 6)
        .map((t) => ({ postAt: t.toISOString(), local: localDateTime(t, tz) }));
      return {
        now: localDateTime(new Date(), tz),
        instagramMode: instagram.mode,
        approvalMode: config.publishing.autoPublish ? 'auto-publish' : 'owner approves every post',
        ebayCatalog: catalog
          ? { updatedAt: catalog.updatedAt, listings: catalog.listings.map(({ description, ...l }) => l) }
          : 'No catalog yet: run Claudius at least once so Iris can see the eBay listings.',
        activeEbaySales: activeSales(),
        storeEventsThisWeek: recentStoreEvents(7),
        claudiusSocialDrafts: claudiusSocialDrafts(7),
        marketplaceItems: readMarketplace(),
        ownerPhotos: listLocalPhotos(),
        queue: summarizeQueue(queue, tz),
        recentInstagramPosts: recent,
        publishingQuota24h: quota,
        freeSlots: slots,
      };
    }

    case 'look_at_photo':
      return { blocks: photoBlocks(input.source) };

    case 'host_photo':
      return { url: await hostPhoto(input.filename) };

    case 'queue_post': {
      if (counters.queued >= config.publishing.maxQueuedPerRun) {
        return blocked(`Limit of ${config.publishing.maxQueuedPerRun} new posts per run reached.`);
      }
      const queue = loadQueue();
      const post = {
        imageUrls: input.image_urls, caption: input.caption.trim(), featuredSkus: input.featured_skus,
        marketplaceItemIds: input.marketplace_item_ids, postAt: input.post_at,
      };
      const check = validate({ ...post, queue, config });
      if (!check.ok) return blocked(check.reason);
      counters.queued++;
      const entry = {
        id: nextPostId(queue), ...post, postAt: new Date(post.postAt).toISOString(),
        status: config.publishing.autoPublish ? 'approved' : 'draft',
        reason: input.reason, createdAt: new Date().toISOString(),
      };
      queue.push(entry);
      saveQueue(queue);
      logAction({ type: 'queued', postId: entry.id, status: entry.status, postAt: entry.postAt, reason: input.reason });
      return { queued: entry.id, status: entry.status, when: localDateTime(new Date(entry.postAt), tz) };
    }

    case 'revise_post': {
      const queue = loadQueue();
      const post = queue.find((q) => q.id === input.post_id);
      if (!post) return { error: `No post ${input.post_id}.` };
      if (!['draft', 'approved'].includes(post.status)) return { error: `${post.id} is ${post.status} and can't be changed.` };
      const next = { ...post, caption: input.caption.trim() || post.caption, postAt: input.post_at || post.postAt };
      const check = validate({ ...next, queue, ignoreId: post.id, config });
      if (!check.ok) return blocked(check.reason);
      Object.assign(post, next, {
        postAt: new Date(next.postAt).toISOString(),
        status: config.publishing.autoPublish ? post.status : 'draft',
        revisedAt: new Date().toISOString(),
      });
      saveQueue(queue);
      logAction({ type: 'revised', postId: post.id });
      return { revised: post.id, status: post.status, when: localDateTime(new Date(post.postAt), tz) };
    }

    case 'draft_marketplace_listing': {
      const item = readMarketplace().find((m) => m.id === input.item_id);
      if (!item) return { error: `No Marketplace item ${input.item_id} in marketplace.json.` };
      fs.mkdirSync(OUTBOX_DIR, { recursive: true });
      const file = path.join(OUTBOX_DIR, `marketplace-${item.id}.md`);
      fs.writeFileSync(file, [
        `# Facebook Marketplace listing: ${item.id}`, '',
        `**Title:** ${input.title}`, `**Price:** $${Number(item.price).toFixed(2)}`,
        `**Category:** ${input.category}`, `**Condition:** ${item.condition}`, '',
        '**Description:**', input.description, '',
        `**Photos:** ${(item.photos || []).join(', ')}`,
      ].join('\n'));
      logAction({ type: 'marketplace_draft', itemId: item.id });
      return { saved: path.relative(path.dirname(OUTBOX_DIR), file) };
    }

    case 'escalate_to_owner':
      escalate(input);
      return { escalated: true };

    case 'save_note':
      appendNote(input.note);
      return { saved: true };

    default:
      return { error: `Unknown tool ${name}` };
  }
}
