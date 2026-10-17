// tools.js — everything Claudius can do, and the guardrail check in front of
// each action that touches the store or a buyer.
import fs from 'node:fs';
import path from 'node:path';
import * as guard from './guardrails.js';
import {
  ROOT, today, logAction, escalate, appendNote, recordBaseline, startOfDayPrice, saveState,
} from './state.js';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const reason = str('One sentence on why: the evidence behind this action. Goes in the audit log and the owner report.');
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const TOOLS = [
  {
    name: 'get_store_overview',
    description: 'Snapshot of the whole store: every listing with price, stock, views, impressions, sales and conversion; orders from the last 7 days; unanswered buyer messages; and active promotions. Call this first in every run.',
    input_schema: obj({}),
  },
  {
    name: 'get_listing',
    description: 'Full details of one listing, including its description and price floor.',
    input_schema: obj({ sku: str('Listing SKU') }),
  },
  {
    name: 'research_market',
    description: 'Search live eBay listings for a query and return competitor titles, prices, shipping and sellers. Use it before changing a price or writing a new listing.',
    input_schema: obj({ query: str('Search terms, as a buyer would type them') }),
  },
  {
    name: 'set_price',
    description: 'Change the price of a listing. Code-enforced limits: never below the SKU floor (cost plus minimum margin, or a capped drop from the original price), and no more than the daily % move. If blocked, the reason is returned.',
    input_schema: obj({ sku: str('Listing SKU'), new_price: num('New price in store currency, e.g. 13.95'), reason }),
  },
  {
    name: 'update_listing_copy',
    description: 'Rewrite a listing title (max 80 chars) and/or description to improve search ranking and conversion. Pass an empty string for a field you are not changing.',
    input_schema: obj({ sku: str('Listing SKU'), title: str('New title, or "" to keep'), description: str('New description (plain text or simple HTML), or "" to keep'), reason }),
  },
  {
    name: 'create_listing',
    description: 'Publish a new fixed-price listing. Needs at least one hosted image URL. Use only for variants or products the owner already makes (see notes); never invent products the store cannot ship.',
    input_schema: obj({
      sku: str('New unique SKU'),
      title: str('Title, max 80 chars'),
      description: str('Description'),
      price: num('Price'),
      quantity: { type: 'integer', description: 'Stock quantity' },
      category_id: str('eBay category ID'),
      image_urls: { type: 'array', items: { type: 'string' }, description: 'Hosted image URLs' },
      reason,
    }),
  },
  {
    name: 'list_buyer_messages',
    description: 'Unanswered buyer questions, with the listing each one is about.',
    input_schema: obj({}),
  },
  {
    name: 'reply_to_buyer',
    description: 'Send a reply to a buyer question. Blocked automatically for refunds, returns, damage, disputes, money, off-eBay contact or guarantees: those go to escalate_to_owner.',
    input_schema: obj({ message_id: str('Message ID from list_buyer_messages'), reply: str('Reply text, in the store voice') }),
  },
  {
    name: 'create_sale',
    description: 'Schedule a markdown sale (percent off) on one or more listings, starting now. Limited by the max discount and max duration.',
    input_schema: obj({
      name: str('Sale name buyers will see, e.g. "Spring Garden Sale"'),
      skus: { type: 'array', items: { type: 'string' }, description: 'SKUs to include' },
      discount_pct: num('Percent off, e.g. 10'),
      days: { type: 'integer', description: 'How many days the sale runs' },
      reason,
    }),
  },
  {
    name: 'promote_listings',
    description: 'Put listings into a Promoted Listings (cost-per-sale) campaign. You pay the ad rate only when a promoted click leads to a sale. Capped at the max ad rate.',
    input_schema: obj({
      skus: { type: 'array', items: { type: 'string' }, description: 'SKUs to promote' },
      ad_rate_pct: num('Ad rate percent, e.g. 4'),
      reason,
    }),
  },
  {
    name: 'draft_social_post',
    description: 'Write a social media post promoting the store or a listing. Saved to the outbox for the owner to post (Claudius does not have social accounts).',
    input_schema: obj({
      platform: { type: 'string', enum: ['instagram', 'facebook', 'tiktok', 'reddit'], description: 'Target platform' },
      sku: str('SKU featured, or "" for the whole store'),
      text: str('Post copy, ready to paste'),
      image_idea: str('What photo or short video to pair with it'),
    }),
  },
  {
    name: 'escalate_to_owner',
    description: 'Hand something to the owner: disputes, refunds, damaged items, anything legal, money decisions above your limits, or ideas that need their go-ahead (new products, policy changes).',
    input_schema: obj({
      subject: str('Short subject'),
      details: str('What happened, what you recommend, and any buyer/listing IDs'),
      urgency: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'urgent = needs a response today' },
    }),
  },
  {
    name: 'save_note',
    description: 'Save a lesson or fact to long-term memory (e.g. "26oz Rambler buyers ask about fit, so add it to the title"). Notes are shown to you at the start of every run.',
    input_schema: obj({ note: str('The note') }),
  },
].map((t) => ({ ...t, strict: true }));

// Tools that change the store or contact a buyer; skipped in --dry-run.
const WRITE_TOOLS = new Set(['set_price', 'update_listing_copy', 'create_listing', 'reply_to_buyer', 'create_sale', 'promote_listings']);

export function createToolContext({ store, config, state, dryRun = false }) {
  return { store, config, state, dryRun, counters: { prices: 0, replies: 0, listings: 0 } };
}

export async function executeTool(name, input, ctx) {
  const { store, config, state, counters } = ctx;
  if (WRITE_TOOLS.has(name) && guard.isPaused()) {
    return { error: 'Claudius is paused by the owner (STOP file or CLAUDIUS_PAUSED=1). No store changes allowed. Report only.' };
  }
  const blocked = (check, extra = {}) => {
    logAction({ type: 'blocked', tool: name, reason: check.reason, input, ...extra });
    return { error: `Blocked by guardrail: ${check.reason}` };
  };
  const act = async (fn, entry) => {
    if (ctx.dryRun) {
      logAction({ type: 'dry_run', tool: name, input });
      return { dryRun: true, wouldHave: entry };
    }
    const result = await fn();
    logAction({ type: 'action', tool: name, ...entry });
    return result;
  };

  switch (name) {
    case 'get_store_overview': {
      const [listings, traffic, orders, messages, promotions] = await Promise.all([
        store.listListings(),
        store.trafficReport({ days: 30 }).catch((e) => ({ error: e.message })),
        store.listOrders({ days: 7 }).catch((e) => ({ error: e.message })),
        store.listMessages().catch((e) => ({ error: e.message })),
        store.listPromotions().catch((e) => ({ error: e.message })),
      ]);
      const trafficBySku = Array.isArray(traffic) ? Object.fromEntries(traffic.map((t) => [t.sku, t])) : {};
      for (const l of listings) recordBaseline(state, l.sku, l.price);
      saveState(state);
      return {
        mode: store.mode,
        date: today(),
        listings: listings.map((l) => ({
          sku: l.sku, title: l.title, price: l.price, quantity: l.quantity,
          floor: guard.priceFloor({ sku: l.sku, baseline: state.baselines[l.sku], config }),
          last30d: trafficBySku[l.sku]
            ? (({ views, impressions, sold, conversionPct }) => ({ views, impressions, sold, conversionPct }))(trafficBySku[l.sku])
            : null,
        })),
        ordersLast7d: orders,
        unansweredMessages: Array.isArray(messages) ? messages.length : messages,
        promotions,
        trafficError: traffic.error,
      };
    }

    case 'get_listing': {
      const l = await store.getListing(input.sku);
      const baseline = recordBaseline(state, l.sku, l.price);
      return { ...l, floor: guard.priceFloor({ sku: l.sku, baseline, config }), originalPrice: baseline };
    }

    case 'research_market':
      return store.searchMarket(input.query);

    case 'set_price': {
      const current = await store.getListing(input.sku);
      const baseline = recordBaseline(state, input.sku, current.price);
      const startOfDay = startOfDayPrice(state, input.sku, current.price);
      saveState(state);
      const check = guard.checkPriceChange({
        sku: input.sku, newPrice: input.new_price, startOfDay, baseline, changesThisRun: counters.prices, config,
      });
      if (!check.ok) return blocked(check);
      counters.prices++;
      return act(() => store.updatePrice(input.sku, input.new_price),
        { sku: input.sku, from: current.price, to: input.new_price, reason: input.reason });
    }

    case 'update_listing_copy': {
      const title = input.title?.trim() || undefined;
      const description = input.description?.trim() || undefined;
      if (!title && !description) return { error: 'Nothing to change.' };
      if (title && title.length > 80) return blocked({ reason: 'eBay titles must be 80 characters or fewer.' });
      const before = await store.getListing(input.sku);
      return act(() => store.updateListing(input.sku, { title, description }),
        { sku: input.sku, titleFrom: title ? before.title : undefined, titleTo: title, descriptionChanged: !!description, reason: input.reason });
    }

    case 'create_listing': {
      const check = guard.checkNewListing({
        title: input.title, price: input.price, sku: input.sku, createdThisRun: counters.listings, config,
      });
      if (!check.ok) return blocked(check);
      counters.listings++;
      return act(() => store.createListing({
        sku: input.sku, title: input.title, description: input.description, price: input.price,
        quantity: input.quantity, categoryId: input.category_id, imageUrls: input.image_urls,
      }), { sku: input.sku, title: input.title, price: input.price, reason: input.reason });
    }

    case 'list_buyer_messages': {
      const messages = await store.listMessages();
      return messages.map((m) => ({
        ...m,
        mustEscalate: guard.needsEscalation(`${m.subject} ${m.body}`, config).length > 0,
      }));
    }

    case 'reply_to_buyer': {
      const msg = await store.getMessage(input.message_id);
      const check = guard.checkBuyerReply({
        reply: input.reply, buyerText: `${msg.subject} ${msg.body}`, repliesThisRun: counters.replies, config,
      });
      if (!check.ok) return blocked(check, { messageId: input.message_id });
      counters.replies++;
      return act(() => store.replyToMessage(input.message_id, input.reply),
        { messageId: input.message_id, to: msg.from, reply: input.reply });
    }

    case 'create_sale': {
      const check = guard.checkPromotion({ discountPct: input.discount_pct, days: input.days, config });
      if (!check.ok) return blocked(check);
      // A sale must not push the effective price below any SKU's floor.
      for (const sku of input.skus) {
        const l = await store.getListing(sku);
        const floor = guard.priceFloor({ sku, baseline: recordBaseline(state, sku, l.price), config });
        const salePrice = l.price * (1 - input.discount_pct / 100);
        if (salePrice < floor) {
          return blocked({ reason: `${sku} would sell at $${salePrice.toFixed(2)}, below its floor of $${floor}.` });
        }
      }
      const start = new Date(Date.now() + 5 * 60_000);
      const end = new Date(start.getTime() + input.days * 86400_000);
      return act(() => store.createMarkdownSale({
        name: input.name, skus: input.skus, discountPct: input.discount_pct,
        startDate: start.toISOString(), endDate: end.toISOString(),
      }), { name: input.name, skus: input.skus, discountPct: input.discount_pct, days: input.days, reason: input.reason });
    }

    case 'promote_listings': {
      const check = guard.checkAdRate({ adRatePct: input.ad_rate_pct, config });
      if (!check.ok) return blocked(check);
      return act(() => store.promoteListings({ skus: input.skus, adRatePct: input.ad_rate_pct }),
        { skus: input.skus, adRatePct: input.ad_rate_pct, reason: input.reason });
    }

    case 'draft_social_post': {
      const dir = path.join(ROOT, 'outbox');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${today()}-${input.platform}-${Date.now() % 100000}.md`);
      fs.writeFileSync(file,
        `# ${input.platform} post${input.sku ? ` — ${input.sku}` : ''}\n\n${input.text}\n\n**Image/video idea:** ${input.image_idea}\n`);
      logAction({ type: 'social_draft', platform: input.platform, sku: input.sku, file: path.relative(ROOT, file) });
      return { saved: path.relative(ROOT, file) };
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
