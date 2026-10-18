// publisher.js — publishes approved posts whose time has come. No AI here:
// it is plain code, so only what the owner approved (or autoPublish allowed)
// ever goes out, with the guardrails checked once more at publish time.
import * as guard from './guardrails.js';
import { pricesFor } from './sources.js';
import { loadQueue, saveQueue, logAction } from './state.js';
import { localDate } from './time.js';

const MAX_ATTEMPTS = 3;

export async function publishDue({ instagram, config, now = new Date() }) {
  if (guard.isPaused()) return { published: [], skipped: 'paused' };
  const queue = loadQueue();
  const due = queue.filter((q) => q.status === 'approved' && new Date(q.postAt) <= now)
    .sort((a, b) => new Date(a.postAt) - new Date(b.postAt));
  const published = [];
  const failed = [];

  for (const post of due) {
    const today = localDate(now, config.publishing.timezone);
    const doneToday = queue.filter((q) => q.status === 'published'
      && localDate(new Date(q.publishedAt), config.publishing.timezone) === today).length;
    if (doneToday >= config.publishing.maxPostsPerDay) break;

    // Prices or sales may have changed since the post was written.
    const { prices, discounts } = pricesFor({ skus: post.featuredSkus, marketplaceIds: post.marketplaceItemIds });
    const check = guard.checkCaption({ caption: post.caption, allowedPrices: prices, allowedDiscounts: discounts, config });
    if (!check.ok) {
      post.status = 'failed';
      post.error = `Held back at publish time: ${check.reason}`;
      failed.push(post);
      logAction({ type: 'publish_blocked', postId: post.id, reason: check.reason });
      continue;
    }

    try {
      const { mediaId, permalink } = await instagram.publish({ imageUrls: post.imageUrls, caption: post.caption });
      Object.assign(post, { status: 'published', publishedAt: new Date().toISOString(), mediaId, permalink });
      delete post.error;
      published.push(post);
      logAction({ type: 'published', postId: post.id, permalink });
    } catch (err) {
      post.attempts = (post.attempts || 0) + 1;
      post.error = err.message;
      if (post.attempts >= MAX_ATTEMPTS) post.status = 'failed';
      failed.push(post);
      logAction({ type: 'publish_error', postId: post.id, error: err.message, attempts: post.attempts });
    }
    saveQueue(queue);
  }
  saveQueue(queue);
  return { published, failed };
}
