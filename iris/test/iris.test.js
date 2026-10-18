import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated fixture: a fake Claudius data dir, marketplace file and photos.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-test-'));
const claudius = path.join(tmp, 'claudius');
fs.mkdirSync(path.join(claudius, 'data'), { recursive: true });
fs.writeFileSync(path.join(claudius, 'data', 'catalog.json'), JSON.stringify({
  updatedAt: new Date().toISOString(),
  listings: [
    { sku: 'YETI-BOOT', title: 'TPU Bumper Boot for YETI Rambler', price: 12.95, quantity: 25, imageUrls: ['https://i.ebayimg.com/yeti.jpg'] },
    { sku: 'PROP-STATION-3', title: 'Set of 3 Propagation Stations', price: 24.95, quantity: 8, imageUrls: ['https://i.ebayimg.com/prop.jpg'] },
    { sku: 'GONE', title: 'Sold out thing', price: 10, quantity: 0, imageUrls: ['https://i.ebayimg.com/gone.jpg'] },
  ],
}));
fs.writeFileSync(path.join(claudius, 'data', 'actions.jsonl'), JSON.stringify({
  at: new Date().toISOString(), type: 'action', tool: 'create_sale', name: 'Spring Planting Sale',
  skus: ['PROP-STATION-3'], discountPct: 10, days: 7,
}) + '\n');
const mpFile = path.join(tmp, 'marketplace.json');
fs.writeFileSync(mpFile, JSON.stringify([{ id: 'fbm-1', title: 'Misprint pots', price: 10, condition: 'Used', photos: [], status: 'available' }]));
fs.mkdirSync(path.join(tmp, 'photos'));
fs.writeFileSync(path.join(tmp, 'photos', 'printer.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

Object.assign(process.env, {
  CLAUDIUS_DIR: claudius, IRIS_DATA_DIR: path.join(tmp, 'data'), IRIS_PHOTOS_DIR: path.join(tmp, 'photos'),
  IRIS_MARKETPLACE_FILE: mpFile, IG_MODE: 'mock',
});

const { checkCaption, checkSchedule } = await import('../src/guardrails.js');
const { upcomingSlots, offsetMinutes, localDate } = await import('../src/time.js');
const { pricesFor } = await import('../src/sources.js');
const { createAgent } = await import('../src/agent.js');
const { createToolContext, TOOLS } = await import('../src/tools.js');
const { createMockInstagram } = await import('../src/instagram/mock.js');
const { publishDue } = await import('../src/publisher.js');
const { loadQueue, saveQueue } = await import('../src/state.js');
const config = JSON.parse(fs.readFileSync(new URL('../iris.config.json', import.meta.url)));

test('time: Sydney offsets and slots', () => {
  assert.equal(offsetMinutes(new Date('2026-01-15T00:00:00Z'), 'Australia/Sydney'), 660); // AEDT
  assert.equal(offsetMinutes(new Date('2026-07-15T00:00:00Z'), 'Australia/Sydney'), 600); // AEST
  const now = new Date('2026-10-18T02:00:00Z'); // 1pm AEDT
  const [first, second] = upcomingSlots({ now, timeZone: 'Australia/Sydney', slots: ['11:30', '19:30'], count: 2 });
  assert.equal(first.toISOString(), '2026-10-18T08:30:00.000Z'); // 7:30pm today
  assert.equal(second.toISOString(), '2026-10-19T00:30:00.000Z'); // 11:30am tomorrow
  assert.equal(localDate(first, 'Australia/Sydney'), '2026-10-18');
});

test('prices: real price and active sale price are allowed', () => {
  const { prices, discounts } = pricesFor({ skus: ['PROP-STATION-3'], marketplaceIds: ['fbm-1'] });
  assert.deepEqual(prices.sort(), [10, 22.46, 24.95].sort());
  assert.deepEqual(discounts, [10]);
});

test('captions: invented prices, discounts and banned phrases are blocked', () => {
  const base = { allowedPrices: [24.95, 22.46], allowedDiscounts: [10], config };
  assert.equal(checkCaption({ ...base, caption: 'Spring sale! 10% off, now $22.46. Link in bio #plants' }).ok, true);
  assert.match(checkCaption({ ...base, caption: 'Huge deal, only $15 this week!' }).reason, /not a current price/);
  assert.match(checkCaption({ ...base, caption: 'Massive 30% off everything today!' }).reason, /active sale/);
  assert.match(checkCaption({ ...base, caption: 'Officially licensed YETI accessory' }).reason, /banned/);
  assert.match(checkCaption({ ...base, caption: 'Tags ' + Array.from({ length: 16 }, (_, i) => `#t${i}`).join(' ') }).reason, /hashtags/);
});

test('schedule: daily cap and minimum gap', () => {
  const now = new Date('2026-10-18T02:00:00Z');
  const q = [{ id: 'P001', status: 'approved', postAt: '2026-10-18T08:30:00.000Z' }];
  assert.match(checkSchedule({ postAt: '2026-10-18T09:30:00Z', queue: q, now, config }).reason, /hours/);
  assert.equal(checkSchedule({ postAt: '2026-10-19T00:30:00Z', queue: q, now, config }).ok, true);
  const two = [...q, { id: 'P002', status: 'published', publishedAt: '2026-10-18T02:30:00.000Z', postAt: '2026-10-18T02:30:00.000Z' }];
  assert.match(checkSchedule({ postAt: '2026-10-18T12:00:00Z', queue: two, now, config }).reason, /limit is 2 per day/);
  assert.match(checkSchedule({ postAt: '2026-10-18T01:00:00Z', queue: [], now, config }).reason, /future/);
});

test('tools are strict', () => {
  for (const t of TOOLS) assert.equal(t.input_schema.additionalProperties, false, t.name);
});

test('agent run: briefing, photo, queue (one blocked), drafts need approval, publisher', async () => {
  const slot = upcomingSlots({ timeZone: 'Australia/Sydney', slots: config.publishing.postingSlots, count: 3 });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const turns = [
    { stop: 'tool_use', content: [use('a', 'get_briefing', {})] },
    { stop: 'tool_use', content: [use('b', 'look_at_photo', { source: 'printer.jpg' }), use('c', 'host_photo', { filename: 'printer.jpg' })] },
    { stop: 'tool_use', content: [
      use('d', 'queue_post', { image_urls: ['https://i.ebayimg.com/prop.jpg'], caption: 'Spring cuttings season 🌱\n10% off our propagation stations, now $22.46. Link in bio.\n#plantpropagation #3dprinted',
        featured_skus: ['PROP-STATION-3'], marketplace_item_ids: [], post_at: slot[0].toISOString(), reason: 'Active spring sale' }),
      use('e', 'queue_post', { image_urls: ['https://i.ebayimg.com/yeti.jpg'], caption: 'YETI boots now just $9.99!',
        featured_skus: ['YETI-BOOT'], marketplace_item_ids: [], post_at: slot[1].toISOString(), reason: 'test bad price' }),
    ] },
    { stop: 'end_turn', content: [{ type: 'text', text: 'Queued 1 post.' }] },
  ];
  const requests = [];
  const client = { beta: { messages: { create: async (req) => {
    requests.push(structuredClone(req));
    const t = turns.shift();
    return { stop_reason: t.stop, content: t.content, usage: {} };
  } } } };
  const instagram = createMockInstagram();
  const agent = createAgent({ config, toolCtx: createToolContext({ instagram, config }), client });
  const { text } = await agent.send('plan');
  assert.equal(text, 'Queued 1 post.');

  const briefing = JSON.parse(requests[1].messages.at(-1).content[0].content);
  assert.equal(briefing.ebayCatalog.listings.length, 3);
  assert.equal(briefing.activeEbaySales[0].discountPct, 10);
  assert.ok(briefing.freeSlots.length > 0);

  const photoResult = requests[2].messages.at(-1).content[0];
  assert.equal(photoResult.content[0].type, 'image');           // Claude sees the photo
  assert.match(JSON.parse(requests[2].messages.at(-1).content[1].content).url, /^https:/);

  const queueResults = requests[3].messages.at(-1).content;
  assert.equal(queueResults[0].is_error, false);
  assert.equal(queueResults[1].is_error, true);                 // invented $9.99

  const queue = loadQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'draft');                        // approval mode

  // Drafts never publish; approved + due posts do.
  const far = new Date(Date.now() + 30 * 86400_000);
  assert.equal((await publishDue({ instagram, config, now: far })).published.length, 0);
  queue[0].status = 'approved';
  saveQueue(queue);
  const { published } = await publishDue({ instagram, config, now: far });
  assert.equal(published.length, 1);
  assert.equal(loadQueue()[0].status, 'published');
  assert.match(loadQueue()[0].permalink, /instagram\.com/);
});
