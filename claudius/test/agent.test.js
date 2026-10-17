// End-to-end run against the mock store with a scripted stand-in for Claude,
// to check the loop, tool wiring, guardrails and audit log without API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDIUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claudius-test-'));
process.env.EBAY_MODE = 'mock';

const { createAgent } = await import('../src/agent.js');
const { createToolContext, TOOLS } = await import('../src/tools.js');
const { createStore } = await import('../src/ebay/index.js');
const { loadState, readActions } = await import('../src/state.js');
const config = JSON.parse(fs.readFileSync(new URL('../claudius.config.json', import.meta.url)));

function scriptedClient(turns) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      return { stop_reason: next.stop, content: next.content, usage: { input_tokens: 1, output_tokens: 1 } };
    } } },
  };
}
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('tool schemas are strict and closed', () => {
  for (const t of TOOLS) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
  }
});

test('a full run: overview, reply, blocked reply, price change, escalation', async () => {
  const client = scriptedClient([
    { stop: 'tool_use', content: [use('t1', 'get_store_overview', {}), use('t2', 'list_buyer_messages', {})] },
    { stop: 'tool_use', content: [
      use('t3', 'reply_to_buyer', { message_id: 'MSG-1', reply: 'Yes! It fits the 26oz Rambler. Cheers.' }),
      use('t4', 'reply_to_buyer', { message_id: 'MSG-3', reply: 'Sorry, I will send a refund.' }),
      use('t5', 'set_price', { sku: 'TREAD-BOTTLE', new_price: 22.95, reason: 'Low conversion vs competitors' }),
      use('t6', 'set_price', { sku: 'TREAD-BOTTLE', new_price: 5, reason: 'test floor' }),
    ] },
    { stop: 'tool_use', content: [use('t7', 'escalate_to_owner', { subject: 'Broken clip', details: 'MSG-3 grumpy_g', urgency: 'urgent' })] },
    { stop: 'end_turn', content: [{ type: 'text', text: 'Report: done.' }] },
  ]);
  const store = createStore();
  const toolCtx = createToolContext({ store, config, state: loadState() });
  const agent = createAgent({ config, toolCtx, client });

  const result = await agent.send('Run your routine.');
  assert.equal(result.text, 'Report: done.');

  // Request shape
  const req = client.requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req.fallbacks, 'default');

  // Tool results came back in one user message, errors flagged
  const results = client.requests[2].messages.at(-1).content;
  assert.equal(results.length, 4);
  assert.equal(results[0].is_error, false);
  assert.equal(results[1].is_error, true);   // refund reply blocked
  assert.equal(results[2].is_error, false);  // 24.95 -> 22.95 ok
  assert.equal(results[3].is_error, true);   // below floor

  assert.equal((await store.getListing('TREAD-BOTTLE')).price, 22.95);
  const msgs = await store.listMessages();
  assert.deepEqual(msgs.map((m) => m.messageId).sort(), ['MSG-2', 'MSG-3']);

  const types = readActions().map((a) => a.type);
  assert.ok(types.includes('action') && types.includes('blocked') && types.includes('escalation'));
});

test('dry run never changes the store', async () => {
  const client = scriptedClient([
    { stop: 'tool_use', content: [use('d1', 'set_price', { sku: 'OOSH-LABEL', new_price: 4.29, reason: 'test' })] },
    { stop: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
  ]);
  const store = createStore();
  const before = (await store.getListing('OOSH-LABEL')).price;
  const agent = createAgent({ config, toolCtx: createToolContext({ store, config, state: loadState(), dryRun: true }), client });
  await agent.send('go');
  assert.equal((await store.getListing('OOSH-LABEL')).price, before);
});
