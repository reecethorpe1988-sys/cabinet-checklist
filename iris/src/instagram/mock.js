// mock.js — a simulated Instagram account. "Published" posts are recorded in
// data/mock-instagram.json; nothing leaves your machine.
import path from 'node:path';
import { DATA_DIR, readJson, writeJson } from '../state.js';

const FILE = () => path.join(DATA_DIR, 'mock-instagram.json');
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

function seed() {
  return {
    posts: [
      { id: 'm3', at: daysAgo(2), type: 'IMAGE', permalink: 'https://instagram.com/p/mock3', caption: 'Fresh batch of YETI boots off the printer…', likes: 41, comments: 3, reach: 620, saved: 9, shares: 4 },
      { id: 'm2', at: daysAgo(6), type: 'CAROUSEL_ALBUM', permalink: 'https://instagram.com/p/mock2', caption: 'Full Ooshies collection, finally displayed properly…', likes: 88, comments: 12, reach: 1430, saved: 31, shares: 15 },
      { id: 'm1', at: daysAgo(11), type: 'IMAGE', permalink: 'https://instagram.com/p/mock1', caption: 'Monstera coasters in the wild…', likes: 22, comments: 1, reach: 380, saved: 4, shares: 0 },
    ],
  };
}

export function createMockInstagram() {
  const load = () => readJson(FILE(), null) || seed();
  return {
    mode: 'mock',

    async publish({ imageUrls, caption }) {
      const db = load();
      const id = `m${db.posts.length + 1}`;
      const post = { id, at: new Date().toISOString(), type: imageUrls.length > 1 ? 'CAROUSEL_ALBUM' : 'IMAGE',
        permalink: `https://instagram.com/p/mock${db.posts.length + 1}`, caption: caption.slice(0, 200),
        likes: 0, comments: 0, reach: 0, saved: 0, shares: 0, imageUrls };
      db.posts.unshift(post);
      writeJson(FILE(), db);
      return { mediaId: id, permalink: post.permalink };
    },

    async recentPosts({ limit = 12 } = {}) {
      return load().posts.slice(0, limit).map(({ imageUrls, ...p }) => p);
    },

    async publishingQuota() {
      const used = load().posts.filter((p) => Date.now() - Date.parse(p.at) < 86400_000).length;
      return { used, limit: 100 };
    },
  };
}
