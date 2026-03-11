// server/routes.js — REST API routes
'use strict';
const express  = require('express');
const db       = require('./db');
const { sendNotification, RECIPIENTS } = require('./mailer');
const router   = express.Router();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function parseProject(row) {
  if (!row) return null;
  return {
    ...row,
    checklist: JSON.parse(row.checklist || '{}'),
  };
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

// ─────────────────────────────────────────────
// PROJECTS
// ─────────────────────────────────────────────

// GET /api/projects?type=cab&status=active
router.get('/projects', (req, res) => {
  const { type, status } = req.query;
  let sql = 'SELECT * FROM projects WHERE 1=1';
  const params = [];
  if (type)   { sql += ' AND type=?';   params.push(type); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(parseProject));
});

// GET /api/projects/:id
router.get('/projects/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(parseProject(row));
});

// POST /api/projects — create new
router.post('/projects', (req, res) => {
  const { type, name, pm, due, notes, checklist } = req.body;
  if (!type || !name) return res.status(400).json({ error: 'type and name are required' });
  const result = db.prepare(`
    INSERT INTO projects (type, name, pm, due, notes, checklist, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(type, name, pm || 'Unassigned', due || null, notes || '', JSON.stringify(checklist || {}));
  const created = parseProject(db.prepare('SELECT * FROM projects WHERE id=?').get(result.lastInsertRowid));
  res.status(201).json(created);
});

// PATCH /api/projects/:id — update fields
router.patch('/projects/:id', (req, res) => {
  const allowed = ['name','pm','due','notes','checklist','status','archived_date','completion_pct'];
  const updates = [];
  const params  = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key}=?`);
      params.push(key === 'checklist' ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
  updates.push("updated_at=datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE projects SET ${updates.join(',')} WHERE id=?`).run(...params);
  res.json(parseProject(db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id)));
});

// DELETE /api/projects/:id
router.delete('/projects/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
  res.json({ deleted: req.params.id });
});

// POST /api/projects/:id/archive
router.post('/projects/:id/archive', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const archivedDate = new Date().toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
  const pct = req.body.completion_pct ?? 0;
  db.prepare(`
    UPDATE projects
    SET status='archived', archived_date=?, completion_pct=?, updated_at=datetime('now')
    WHERE id=?
  `).run(archivedDate, pct, req.params.id);
  res.json(parseProject(db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id)));
});

// POST /api/projects/:id/restore
router.post('/projects/:id/restore', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE projects
    SET status='active', archived_date=NULL, completion_pct=0, updated_at=datetime('now')
    WHERE id=?
  `).run(req.params.id);
  res.json(parseProject(db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id)));
});

// ─────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────

// GET /api/notifications
router.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

// POST /api/notifications/send — send real email + log it
router.post('/notifications/send', async (req, res) => {
  const { recipients, subject, projectName, milestone, note, dueDate, checklistType, logOnly } = req.body;
  if (!recipients?.length) return res.status(400).json({ error: 'recipients required' });

  const toKeys  = Array.isArray(recipients) ? recipients : [recipients];
  const toEmails = toKeys.map(r => RECIPIENTS[r] || r).filter(Boolean);
  const detail   = `To: ${toEmails.join(', ')}`;
  const title    = subject || `${milestone || 'Update'} — ${projectName || 'Project'}`;

  // Log to DB first
  const ins = db.prepare(
    'INSERT INTO notifications (type,emoji,title,detail,time_label) VALUES (?,?,?,?,?)'
  );

  if (logOnly) {
    ins.run('pending', '⏳', title, detail, 'Just now');
    return res.json({ logged: true });
  }

  try {
    await sendNotification({ recipients: toKeys, subject: title, projectName, milestone, note, dueDate, checklistType });
    ins.run('sent', '📧', title, detail, 'Just now');
    res.json({ sent: true, to: toEmails });
  } catch (err) {
    console.error('Email error:', err.message);
    ins.run('failed', '⚠️', title, `${detail} · ${err.message}`, 'Just now');
    res.status(500).json({ error: err.message, detail });
  }
});

// ─────────────────────────────────────────────
// TRIGGERS
// ─────────────────────────────────────────────

// GET /api/triggers?type=cab
router.get('/triggers', (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT * FROM triggers';
  const params = [];
  if (type) { sql += ' WHERE checklist_type=?'; params.push(type); }
  sql += ' ORDER BY id';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, who: JSON.parse(r.who || '[]'), on: !!r.on_flag })));
});

// PATCH /api/triggers/:id
router.patch('/triggers/:id', (req, res) => {
  const { on } = req.body;
  if (on === undefined) return res.status(400).json({ error: 'on (boolean) required' });
  db.prepare('UPDATE triggers SET on_flag=? WHERE id=?').run(on ? 1 : 0, req.params.id);
  const row = db.prepare('SELECT * FROM triggers WHERE id=?').get(req.params.id);
  res.json({ ...row, who: JSON.parse(row.who || '[]'), on: !!row.on_flag });
});

// ─────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────
router.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

module.exports = router;
