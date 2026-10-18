// state.js — Iris's on-disk memory: the post queue, an append-only action
// log, owner escalations, and free-form notes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.IRIS_DATA_DIR || path.join(ROOT, 'data');
export const PHOTOS_DIR = process.env.IRIS_PHOTOS_DIR || path.join(ROOT, 'photos');
export const OUTBOX_DIR = path.join(ROOT, 'outbox');

const file = (name) => path.join(DATA_DIR, name);
const ensureDir = () => fs.mkdirSync(DATA_DIR, { recursive: true });

export function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

// ── Post queue ─────────────────────────────────────────
// status: draft (waiting for owner) → approved → published | failed; or rejected
export function loadQueue() {
  return readJson(file('queue.json'), []);
}

export function saveQueue(queue) {
  ensureDir();
  writeJson(file('queue.json'), queue);
}

export function nextPostId(queue) {
  const max = queue.reduce((m, p) => Math.max(m, Number(p.id.replace(/\D/g, '')) || 0), 0);
  return `P${String(max + 1).padStart(3, '0')}`;
}

// ── Logs, notes, escalations ──────────────────────────
export function logAction(entry) {
  ensureDir();
  fs.appendFileSync(file('actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function readActions({ sinceHours = 24 } = {}) {
  const cutoff = Date.now() - sinceHours * 3600_000;
  try {
    return fs.readFileSync(file('actions.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((a) => Date.parse(a.at) >= cutoff);
  } catch {
    return [];
  }
}

export function escalate({ subject, details, urgency = 'normal' }) {
  ensureDir();
  fs.appendFileSync(file('escalations.md'),
    `\n## [${urgency.toUpperCase()}] ${subject}\n_${new Date().toISOString()}_\n\n${details}\n`);
  logAction({ type: 'escalation', subject, urgency });
}

export function readNotes() {
  try {
    return fs.readFileSync(file('notes.md'), 'utf8');
  } catch {
    return '';
  }
}

export function appendNote(note) {
  ensureDir();
  fs.appendFileSync(file('notes.md'), `- ${new Date().toISOString().slice(0, 10)}: ${note.trim()}\n`);
}
