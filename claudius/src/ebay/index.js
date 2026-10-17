// ebay/index.js — pick the store backend from EBAY_MODE.
import { createMockStore } from './mock.js';
import { createLiveStore } from './live.js';

export function createStore(env = process.env) {
  const mode = (env.EBAY_MODE || 'mock').toLowerCase();
  return mode === 'mock' ? createMockStore() : createLiveStore({ mode, env });
}
