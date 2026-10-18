// live.js — a real Instagram professional account, via the Instagram API with
// Instagram Login (graph.instagram.com). Same interface as mock.js.
import path from 'node:path';
import { DATA_DIR, readJson, writeJson, logAction } from '../state.js';

const TOKEN_FILE = () => path.join(DATA_DIR, 'ig-token.json');
const REFRESH_AFTER_DAYS = 7; // tokens last 60 days; refresh well before that
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLiveInstagram({ env = process.env, pollMs = 10_000 } = {}) {
  const version = env.IG_API_VERSION || 'v25.0';
  const base = `https://graph.instagram.com/${version}`;
  let userId = env.IG_USER_ID || null;

  async function token() {
    let t = readJson(TOKEN_FILE(), null);
    if (!t) {
      if (!env.IG_ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN is required when IG_MODE=live. See README → Connecting Instagram.');
      t = { token: env.IG_ACCESS_TOKEN, refreshedAt: new Date().toISOString() };
      writeJson(TOKEN_FILE(), t);
    }
    if (Date.now() - Date.parse(t.refreshedAt) > REFRESH_AFTER_DAYS * 86400_000) {
      const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.token)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(`Instagram token refresh failed: ${json.error?.message || res.status}. Generate a new token (README).`);
      t = { token: json.access_token, refreshedAt: new Date().toISOString(), expiresInSec: json.expires_in };
      writeJson(TOKEN_FILE(), t);
      logAction({ type: 'token_refreshed' });
    }
    return t.token;
  }

  async function call(method, p, params = {}) {
    const body = new URLSearchParams({ ...params, access_token: await token() });
    const url = method === 'GET' ? `${base}${p}?${body}` : `${base}${p}`;
    const res = await fetch(url, method === 'GET' ? {} : {
      method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`Instagram ${method} ${p} failed: ${json.error?.message || res.status}`);
    return json;
  }

  async function me() {
    if (!userId) userId = (await call('GET', '/me', { fields: 'user_id,username' })).user_id;
    return userId;
  }

  async function waitUntilReady(containerId) {
    for (let i = 0; i < 30; i++) {
      const { status_code: status } = await call('GET', `/${containerId}`, { fields: 'status_code' });
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram could not process the image (status ${status}). Check it is a public JPEG.`);
      await sleep(pollMs);
    }
    throw new Error('Instagram took too long to process the media.');
  }

  return {
    mode: 'live',

    async publish({ imageUrls, caption }) {
      const id = await me();
      let containerId;
      if (imageUrls.length === 1) {
        containerId = (await call('POST', `/${id}/media`, { image_url: imageUrls[0], caption })).id;
      } else {
        const children = [];
        for (const url of imageUrls) {
          children.push((await call('POST', `/${id}/media`, { image_url: url, is_carousel_item: 'true' })).id);
        }
        for (const c of children) await waitUntilReady(c);
        containerId = (await call('POST', `/${id}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption })).id;
      }
      await waitUntilReady(containerId);
      const { id: mediaId } = await call('POST', `/${id}/media_publish`, { creation_id: containerId });
      const { permalink } = await call('GET', `/${mediaId}`, { fields: 'permalink' });
      return { mediaId, permalink };
    },

    async recentPosts({ limit = 12 } = {}) {
      const id = await me();
      const { data = [] } = await call('GET', `/${id}/media`, {
        fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: String(limit),
      });
      return Promise.all(data.map(async (m) => {
        let insights = null;
        try {
          const { data: metrics = [] } = await call('GET', `/${m.id}/insights`, { metric: 'reach,saved,shares' });
          insights = Object.fromEntries(metrics.map((x) => [x.name, x.values?.[0]?.value ?? x.total_value?.value]));
        } catch { /* insights need instagram_business_manage_insights; skip if missing */ }
        return {
          id: m.id, at: m.timestamp, type: m.media_type, permalink: m.permalink,
          caption: (m.caption || '').slice(0, 200), likes: m.like_count, comments: m.comments_count, ...insights,
        };
      }));
    },

    async publishingQuota() {
      const id = await me();
      const { data = [] } = await call('GET', `/${id}/content_publishing_limit`, { fields: 'quota_usage,config' });
      return { used: data[0]?.quota_usage, limit: data[0]?.config?.quota_total };
    },
  };
}
