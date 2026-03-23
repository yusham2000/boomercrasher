'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ── Persist to Railway volume if available, else local ──────────────
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'trades.db');
const db      = new Database(DB_PATH);

// ── Schema ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT    NOT NULL,
    direction   TEXT    NOT NULL,
    entry_price REAL    NOT NULL,
    sl_price    REAL    NOT NULL,
    tp_mode     TEXT    NOT NULL,
    risk_usd    REAL    NOT NULL,
    signal_prob REAL,
    signal_tick INTEGER,
    outcome     TEXT,        -- 'win' | 'sl' | 'open'
    pnl_usd     REAL,
    spike_move  REAL,
    spike_ticks INTEGER,
    opened_at   INTEGER NOT NULL,
    closed_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS spike_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol     TEXT    NOT NULL,
    ticks      INTEGER NOT NULL,
    move       REAL    NOT NULL,
    had_signal INTEGER NOT NULL,
    logged_at  INTEGER NOT NULL
  );
`);

// ── Trade operations ─────────────────────────────────────────────────

const insertTrade = db.prepare(`
  INSERT INTO trades
    (symbol, direction, entry_price, sl_price, tp_mode, risk_usd, signal_prob, signal_tick, outcome, opened_at)
  VALUES
    (@symbol, @direction, @entry_price, @sl_price, @tp_mode, @risk_usd, @signal_prob, @signal_tick, 'open', @opened_at)
`);

const closeTrade = db.prepare(`
  UPDATE trades
  SET outcome = @outcome, pnl_usd = @pnl_usd, spike_move = @spike_move,
      spike_ticks = @spike_ticks, closed_at = @closed_at
  WHERE symbol = @symbol AND outcome = 'open'
  ORDER BY id DESC
  LIMIT 1
`);

const insertSpike = db.prepare(`
  INSERT INTO spike_log (symbol, ticks, move, had_signal, logged_at)
  VALUES (@symbol, @ticks, @move, @had_signal, @logged_at)
`);

// ── Stats queries ────────────────────────────────────────────────────

function getStats() {
  const total  = db.prepare(`SELECT COUNT(*) as n FROM trades WHERE outcome != 'open'`).get();
  const wins   = db.prepare(`SELECT COUNT(*) as n FROM trades WHERE outcome = 'win'`).get();
  const losses = db.prepare(`SELECT COUNT(*) as n FROM trades WHERE outcome = 'sl'`).get();
  const open   = db.prepare(`SELECT COUNT(*) as n FROM trades WHERE outcome = 'open'`).get();
  const pnl    = db.prepare(`SELECT COALESCE(SUM(pnl_usd),0) as total FROM trades`).get();
  const best   = db.prepare(`SELECT * FROM trades WHERE pnl_usd = (SELECT MAX(pnl_usd) FROM trades)`).get();
  const worst  = db.prepare(`SELECT * FROM trades WHERE pnl_usd = (SELECT MIN(pnl_usd) FROM trades)`).get();
  const bySymbol = db.prepare(`
    SELECT symbol,
      COUNT(*) as total,
      SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome='sl'  THEN 1 ELSE 0 END) as losses,
      COALESCE(SUM(pnl_usd),0) as pnl
    FROM trades
    WHERE outcome != 'open'
    GROUP BY symbol
  `).all();
  const recent = db.prepare(`
    SELECT * FROM trades ORDER BY id DESC LIMIT 20
  `).all();

  const winRate = total.n > 0 ? ((wins.n / total.n) * 100).toFixed(1) : '0.0';

  return {
    summary: {
      total:    total.n,
      wins:     wins.n,
      losses:   losses.n,
      open:     open.n,
      winRate:  parseFloat(winRate),
      totalPnl: parseFloat(pnl.total.toFixed(2)),
    },
    best:     best  || null,
    worst:    worst || null,
    bySymbol,
    recent,
  };
}

function getSpikelog() {
  return db.prepare(`SELECT * FROM spike_log ORDER BY id DESC LIMIT 50`).all();
}

module.exports = {
  openTrade(data) {
    return insertTrade.run(data);
  },
  closeTrade(data) {
    return closeTrade.run(data);
  },
  logSpike(data) {
    return insertSpike.run(data);
  },
  getStats,
  getSpikelog,
};
