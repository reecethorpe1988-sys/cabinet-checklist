#!/usr/bin/env node
// index.js — Claudius command line.
//   node src/index.js run [--dry-run] [--task "..."]   one full autonomous cycle
//   node src/index.js chat [--dry-run]                 talk to Claudius / give instructions
//   node src/index.js daemon                           run a cycle every CLAUDIUS_INTERVAL_HOURS
//   node src/index.js status                           recent actions and open escalations
//   node src/index.js migrate <listingId> [...]        one-off: bring ebay.com.au listings into the API
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createAgent, MODEL } from './agent.js';
import { createStore } from './ebay/index.js';
import { createToolContext } from './tools.js';
import { runBrief, DEFAULT_TASK } from './prompt.js';
import { isPaused } from './guardrails.js';
import { ROOT, DATA_DIR, loadState, saveState, readNotes, readActions, today } from './state.js';

const args = process.argv.slice(2);
const command = args[0] || 'run';
const flag = (name) => args.includes(`--${name}`);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'claudius.config.json'), 'utf8'));

function logger() {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const onEvent = (e) => {
    if (e.type === 'tool') console.log(`  → ${e.name} ${JSON.stringify(e.input).slice(0, 160)}`);
    if (e.type === 'tool_result' && e.isError) console.log(`    ✗ ${JSON.stringify(e.output).slice(0, 200)}`);
    if (e.type === 'thought' && e.text.trim()) console.log(`  · ${e.text.trim().slice(0, 300)}`);
    if (e.type === 'usage') {
      usage.input += e.usage.input_tokens || 0;
      usage.output += e.usage.output_tokens || 0;
      usage.cacheRead += e.usage.cache_read_input_tokens || 0;
      usage.cacheWrite += e.usage.cache_creation_input_tokens || 0;
    }
  };
  return { onEvent, usage };
}

function setup(dryRun) {
  const store = createStore();
  const state = loadState();
  const toolCtx = createToolContext({ store, config, state, dryRun });
  const { onEvent, usage } = logger();
  const agent = createAgent({ config, toolCtx, onEvent });
  const brief = (task) => runBrief({
    date: today(), mode: store.mode + (dryRun ? ', DRY RUN: store changes are simulated' : ''),
    notes: readNotes(), recentActions: readActions({ sinceHours: 24 * 7 }), task,
  });
  return { store, state, agent, brief, usage };
}

async function runOnce({ dryRun = flag('dry-run'), task = option('task') || DEFAULT_TASK } = {}) {
  const startedAt = new Date();
  const { store, state, agent, brief, usage } = setup(dryRun);
  console.log(`Claudius run started ${startedAt.toISOString()} (store: ${store.mode}${dryRun ? ', dry run' : ''}, model: ${MODEL})`);
  if (isPaused()) console.log('  ! Paused: Claudius will only report, not change anything.');

  const result = await agent.send(brief(isPaused() ? `${task}\n\nNOTE: The owner has paused you. Do not attempt any store changes; review and report only.` : task));
  state.lastRun = startedAt.toISOString();
  saveState(state);

  const actions = readActions({ sinceHours: (Date.now() - startedAt) / 3600_000 + 0.01 });
  const reportsDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `${startedAt.toISOString().slice(0, 16).replace(':', '')}.md`);
  fs.writeFileSync(file, [
    `# Claudius report: ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Store mode: ${store.mode}${dryRun ? ' (dry run)' : ''}`,
    '',
    result.text,
    '',
    '---',
    `## Audit log (${actions.length} entries)`,
    ...actions.map((a) => `- \`${a.type}\` ${a.tool ?? ''} ${JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !['at', 'type', 'tool'].includes(k))))}`),
    '',
    `Tokens: ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write`,
  ].join('\n'));

  console.log(`\n${result.text}\n\nReport saved to ${path.relative(process.cwd(), file)}`);
  return result;
}

async function chat() {
  const dryRun = flag('dry-run');
  const { store, agent, brief } = setup(dryRun);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Chatting with Claudius (store: ${store.mode}${dryRun ? ', dry run' : ''}). Type "exit" to quit.\n`);
  let first = true;
  for (;;) {
    const line = (await rl.question('you › ')).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    const { text } = await agent.send(first ? brief(`The owner is chatting with you directly. Their message:\n\n${line}`) : line);
    first = false;
    console.log(`\nclaudius › ${text}\n`);
  }
  rl.close();
}

async function daemon() {
  const hours = Number(process.env.CLAUDIUS_INTERVAL_HOURS || 6);
  console.log(`Claudius daemon: a full run every ${hours}h. Create a file named STOP to pause.`);
  for (;;) {
    try {
      await runOnce({ dryRun: false });
    } catch (err) {
      console.error(`Run failed: ${err.stack || err.message}`);
    }
    await new Promise((r) => setTimeout(r, hours * 3600_000));
  }
}

function status() {
  const state = loadState();
  console.log(`Last run: ${state.lastRun || 'never'}   Paused: ${isPaused() ? 'YES' : 'no'}   Store: ${process.env.EBAY_MODE || 'mock'}\n`);
  const actions = readActions({ sinceHours: 72 });
  console.log(`Last 72h: ${actions.length} logged events`);
  for (const a of actions.slice(-25)) console.log(`  ${a.at.slice(0, 16)}  ${a.type.padEnd(12)} ${a.tool ?? ''} ${a.sku ?? a.subject ?? ''}`);
  const esc = path.join(DATA_DIR, 'escalations.md');
  if (fs.existsSync(esc)) console.log(`\nEscalations for you: ${path.relative(process.cwd(), esc)}`);
}

async function migrate() {
  const ids = args.slice(1).filter((a) => /^\d+$/.test(a) || a.startsWith('MOCK'));
  if (!ids.length) {
    console.error('Usage: node src/index.js migrate <listingId> [listingId ...]\nFind listing IDs in each listing URL: ebay.com.au/itm/<listingId>');
    process.exit(1);
  }
  const results = await createStore().migrateListings(ids);
  for (const r of results) {
    console.log(r.ok ? `✓ ${r.listingId} → SKU ${r.skus.join(', ')}` : `✗ ${r.listingId}: ${r.errors.join('; ')}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} migrated, ${failed} failed.`);
}

const commands = { run: () => runOnce(), chat, daemon, status, migrate };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use: run | chat | daemon | status | migrate`);
  process.exit(1);
}
await commands[command]();
