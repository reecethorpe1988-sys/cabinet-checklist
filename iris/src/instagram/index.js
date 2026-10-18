// instagram/index.js — pick the Instagram backend from IG_MODE.
import { createMockInstagram } from './mock.js';
import { createLiveInstagram } from './live.js';

export function createInstagram(env = process.env) {
  return (env.IG_MODE || 'mock').toLowerCase() === 'live' ? createLiveInstagram({ env }) : createMockInstagram();
}
