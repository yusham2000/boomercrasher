'use strict';

const express = require('express');
const cors    = require('cors');
const db      = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ── Trade stats ───────────────────────────────────────────────────────
app.get('/api/stats', (_, res) => {
  try {
    res.json(db.getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Spike log ─────────────────────────────────────────────────────────
app.get('/api/spikes', (_, res) => {
  try {
    res.json(db.getSpikelog());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function startAPI() {
  app.listen(PORT, () => {
    console.log(`[API] Dashboard API running on port ${PORT}`);
  });
}

module.exports = { startAPI };
