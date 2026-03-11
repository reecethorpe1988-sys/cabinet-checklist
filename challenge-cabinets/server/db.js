// server/db.js — SQLite database setup
'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'challenge.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL CHECK(type IN ('cab','stone')),
    name        TEXT    NOT NULL,
    pm          TEXT    NOT NULL DEFAULT 'Unassigned',
    due         TEXT,
    status      TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    notes       TEXT    DEFAULT '',
    checklist   TEXT    NOT NULL DEFAULT '{}',
    archived_date TEXT,
    completion_pct INTEGER DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL CHECK(type IN ('sent','pending','failed')),
    emoji     TEXT NOT NULL DEFAULT '📧',
    title     TEXT NOT NULL,
    detail    TEXT NOT NULL DEFAULT '',
    time_label TEXT NOT NULL DEFAULT 'Just now',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS triggers (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    checklist_type TEXT NOT NULL CHECK(checklist_type IN ('cab','stone')),
    label     TEXT NOT NULL,
    who       TEXT NOT NULL DEFAULT '[]',
    on_flag   INTEGER NOT NULL DEFAULT 1
  );
`);

// ─────────────────────────────────────────────
// SEED initial data if tables are empty
// ─────────────────────────────────────────────
function seedIfEmpty() {
  const projCount = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
  if (projCount > 0) return; // already seeded

  console.log('🌱  Seeding initial data…');

  // Cabinet triggers
  const cabTriggers = [
    { label: 'Notify Supervisors of plan changes',  who: ['matt','arron','reece'] },
    { label: 'Door Order Submitted',                who: ['matt','reece'] },
    { label: 'Laminated Benchtop Plan Emailed',     who: ['matt','reece'] },
    { label: 'Render brief confirmed',              who: ['matt','reece'] },
    { label: 'Finishing schedule issued to shop',   who: ['arron','reece'] },
  ];
  const stoneTriggers = [
    { label: 'Shop drawings issued for approval',  who: ['matt','reece'] },
    { label: 'Slab ordered from supplier',         who: ['matt','arron','reece'] },
    { label: 'Install date confirmed with client', who: ['matt','arron','reece'] },
    { label: 'Client walkthrough & sign-off',      who: ['matt','reece'] },
    { label: 'Job card closed off in system',      who: ['matt','arron','reece'] },
  ];

  const insTrig = db.prepare(
    'INSERT INTO triggers (checklist_type, label, who, on_flag) VALUES (?,?,?,1)'
  );
  for (const t of cabTriggers)   insTrig.run('cab',   t.label, JSON.stringify(t.who));
  for (const t of stoneTriggers) insTrig.run('stone', t.label, JSON.stringify(t.who));

  // Sample archived projects
  const insProj = db.prepare(`
    INSERT INTO projects (type,name,pm,due,status,notes,checklist,archived_date,completion_pct)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  insProj.run(
    'cab','Kowalski Kitchen Reno','James Whitfield','2025-11-15','archived',
    'Handleless doors, island bench','{}','15 Nov 2025',100
  );
  insProj.run(
    'stone','Patel Bathroom Vanity — Stone','Priya Nair','2025-12-02','archived',
    'Calacatta marble-look slab','{}','02 Dec 2025',92
  );

  // Sample notifications
  const insNotif = db.prepare(
    'INSERT INTO notifications (type,emoji,title,detail,time_label) VALUES (?,?,?,?,?)'
  );
  insNotif.run('sent',   '📧','Plan Changes Notified — Henderson Kitchen',
    'To: matt@challengecabinets.com.au, arron@challengecabinets.com.au','1 hr ago');
  insNotif.run('sent',   '📧','Door Order Submitted — Henderson Kitchen',
    'To: matt@challengecabinets.com.au','2 days ago');
  insNotif.run('pending','⏳','Stone Template Booked — Henderson Stone',
    'Will notify when task marked complete','Pending');

  console.log('✅  Seed complete.');
}

seedIfEmpty();

module.exports = db;
