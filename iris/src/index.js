#!/usr/bin/env node
// index.js — Iris command line.
//   plan [--task "..."]        Iris plans and queues posts (needs Claude)
//   queue                      show queued posts
//   show <id>                  full caption and images of one post
//   approve <id...|all>        approve drafts so they publish at their time
//   reject <id...>             drop drafts
//   publish                    publish approved posts that are due (no AI)
//   chat                       talk to Iris ("make P003 funnier", "plan Christmas")
//   daemon                     plan daily + publish every 15 minutes
//   status                     recent activity and escalations
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createAgent, MODEL } from './agent.js';
import { createInstagram } from './instagram/index.js';
import { createToolContext } from './tools.js';
import { publishDue } from './publisher.js';
import { runBrief, DEFAULT_TASK } from './prompt.js';
import { checkSchedule, isPaused } from './guardrails.js';
import { upcomingSlots, localDateTime } from './time.js';
import { ROOT, DATA_DIR, loadQueue, saveQueue, readNotes, readActions, logAction } from './state.js';

const args = process.argv.slice(2);
const command = args[0] || 'queue';
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = () => args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'iris.config.json'), 'utf8'));
const tz = config.publishing.timezone;
const when = (iso) => localDateTime(new Date(iso), tz);

function setup() {
  const instagram = createInstagram();
  const toolCtx = createToolContext({ instagram, config });
  const onEvent = (e) => {
    if (e.type === 'tool') console.log(`  → ${e.name} ${JSON.stringify(e.input).slice(0, 140)}`);
    if (e.type === 'tool_result' && e.isError) console.log(`    ✗ ${JSON.stringify(e.output).slice(0, 200)}`);
  };
  const agent = createAgent({ config, toolCtx, onEvent });
  const brief = (task) => runBrief({ now: when(new Date().toISOString()), notes: readNotes(), recentActions: readActions({ sinceHours: 168 }), task });
  return { instagram, agent, brief };
}

async function plan() {
  const { instagram, agent, brief } = setup();
  console.log(`Iris planning (Instagram: ${instagram.mode}, model: ${MODEL}, ${config.publishing.autoPublish ? 'auto-publish' : 'approval mode'})`);
  if (isPaused()) console.log('  ! Paused: posts can be queued but nothing will publish until STOP is removed.');
  const { text } = await agent.send(brief(option('task') || DEFAULT_TASK));
  console.log(`\n${text}\n`);
  showQueue();
}

function showQueue() {
  const open = loadQueue().filter((q) => ['draft', 'approved', 'failed'].includes(q.status));
  if (!open.length) return console.log('Queue is empty.');
  for (const q of open.sort((a, b) => new Date(a.postAt) - new Date(b.postAt))) {
    const tag = { draft: 'NEEDS APPROVAL', approved: 'approved', failed: 'FAILED' }[q.status];
    console.log(`\n${q.id}  [${tag}]  ${when(q.postAt)}  ${q.imageUrls.length > 1 ? `carousel of ${q.imageUrls.length}` : '1 image'}`);
    console.log(`  ${q.caption.split('\n')[0].slice(0, 100)}`);
    if (q.error) console.log(`  ! ${q.error}`);
  }
  if (open.some((q) => q.status === 'draft')) console.log('\nApprove with: node src/index.js approve <id> (or "all"). See a full post with: node src/index.js show <id>');
}

function show() {
  const q = loadQueue().find((x) => x.id === positional()[0]);
  if (!q) return console.error('Usage: show <id>');
  console.log(`${q.id} [${q.status}] ${when(q.postAt)}\nWhy: ${q.reason}\nFeatures: ${[...q.featuredSkus, ...q.marketplaceItemIds].join(', ') || '(store)'}\nImages:\n${q.imageUrls.map((u) => `  ${u}`).join('\n')}\n\n${q.caption}`);
  if (q.permalink) console.log(`\nLive: ${q.permalink}`);
}

function setStatus(to) {
  const queue = loadQueue();
  let ids = positional();
  if (ids[0] === 'all') ids = queue.filter((q) => q.status === 'draft').map((q) => q.id);
  if (!ids.length) return console.error(`Usage: ${to === 'approved' ? 'approve' : 'reject'} <id...|all>`);
  for (const id of ids) {
    const q = queue.find((x) => x.id === id);
    if (!q) { console.log(`✗ ${id}: not found`); continue; }
    if (!['draft', 'failed', ...(to === 'rejected' ? ['approved'] : [])].includes(q.status)) {
      console.log(`✗ ${id}: is ${q.status}`); continue;
    }
    if (to === 'approved') {
      const at = option('at');
      if (at) q.postAt = new Date(at).toISOString();
      // A draft approved after its slot has passed moves to the next free slot.
      if (new Date(q.postAt) < new Date(Date.now() + 5 * 60_000)) {
        const slot = upcomingSlots({ timeZone: tz, slots: config.publishing.postingSlots, count: 20 })
          .find((t) => checkSchedule({ postAt: t.toISOString(), queue, ignoreId: q.id, config }).ok);
        if (!slot) { console.log(`✗ ${id}: no free slot in the next ${config.publishing.maxDaysAhead} days`); continue; }
        q.postAt = slot.toISOString();
      }
      delete q.error;
      q.attempts = 0;
    }
    q.status = to;
    logAction({ type: to, postId: id, by: 'owner' });
    console.log(`✓ ${id} ${to}${to === 'approved' ? `, posts ${when(q.postAt)}` : ''}`);
  }
  saveQueue(queue);
}

async function publish() {
  const { published, failed, skipped } = await publishDue({ instagram: createInstagram(), config });
  if (skipped) return console.log(`Not publishing: ${skipped}.`);
  for (const p of published) console.log(`✓ Published ${p.id}: ${p.permalink}`);
  for (const p of failed) console.log(`✗ ${p.id}: ${p.error}`);
  if (!published.length && !failed.length) console.log('Nothing due.');
}

async function chat() {
  const { agent, brief } = setup();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Chatting with Iris. Type "exit" to quit.\n');
  let first = true;
  for (;;) {
    const line = (await rl.question('you › ')).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    const { text } = await agent.send(first ? brief(`The owner is chatting with you directly. Their message:\n\n${line}`) : line);
    first = false;
    console.log(`\niris › ${text}\n`);
  }
  rl.close();
}

async function daemon() {
  const planEvery = Number(process.env.IRIS_PLAN_HOURS || 24) * 3600_000;
  let lastPlan = 0;
  console.log(`Iris daemon: planning every ${planEvery / 3600_000}h, publishing due posts every 15 min.`);
  for (;;) {
    try {
      if (Date.now() - lastPlan >= planEvery) { await plan(); lastPlan = Date.now(); }
      await publish();
    } catch (err) {
      console.error(`Error: ${err.stack || err.message}`);
    }
    await new Promise((r) => setTimeout(r, 15 * 60_000));
  }
}

function status() {
  const q = loadQueue();
  const count = (s) => q.filter((x) => x.status === s).length;
  console.log(`Instagram: ${process.env.IG_MODE || 'mock'}   Mode: ${config.publishing.autoPublish ? 'auto-publish' : 'approval'}   Paused: ${isPaused() ? 'YES' : 'no'}`);
  console.log(`Queue: ${count('draft')} need approval, ${count('approved')} approved, ${count('published')} published, ${count('failed')} failed\n`);
  for (const a of readActions({ sinceHours: 72 }).slice(-20)) console.log(`  ${a.at.slice(0, 16)}  ${a.type.padEnd(16)} ${a.postId ?? a.subject ?? ''}`);
  if (fs.existsSync(path.join(DATA_DIR, 'escalations.md'))) console.log(`\nRequests for you: ${path.relative(process.cwd(), path.join(DATA_DIR, 'escalations.md'))}`);
}

const commands = {
  plan, queue: showQueue, show, approve: () => setStatus('approved'), reject: () => setStatus('rejected'),
  publish, chat, daemon, status,
};
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use: ${Object.keys(commands).join(' | ')}`);
  process.exit(1);
}
await commands[command]();
