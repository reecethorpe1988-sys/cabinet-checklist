// server/index.js — Challenge Cabinets backend server
'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const cors    = require('cors');
const routes  = require('./routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── API routes ────────────────────────────────
app.use('/api', routes);

// ── Serve the frontend HTML ───────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  Challenge Cabinets Checklist App    ║
  ║  Running on  http://localhost:${PORT}   ║
  ╚══════════════════════════════════════╝
  `);
});
