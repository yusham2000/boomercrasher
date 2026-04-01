'use strict';

// ═══════════════════════════════════════════════════════════════════
//  BOOM & CRASH ALL-IN-ONE BOT — v3.1
// ═══════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

const CONFIG = {
  TELEGRAM_TOKEN:   '8560354833:AAEAw967bUzoT69fAvWOhIR1QWoaNjTxVSk',
  TELEGRAM_CHAT_ID: '5120084637',

  DERIV_APP_ID:     '1089',
  DERIV_API_TOKEN:  'EJkPCsvw8y87Sra',

  DERIV_WS:         'wss://ws.derivws.com/websockets/v3',

  SYMBOLS: {
    'BOOM1000':  { label: 'Boom 1000',  type: 'boom',  period: 1000, direction: 'UP 📈',   pipValue: 0.10 },
    'BOOM500':   { label: 'Boom 500',   type: 'boom',  period: 500,  direction: 'UP 📈',   pipValue: 0.10 },
    'CRASH1000': { label: 'Crash 1000', type: 'crash', period: 1000, direction: 'DOWN 📉', pipValue: 0.10 },
    'CRASH500':  { label: 'Crash 500',  type: 'crash', period: 500,  direction: 'DOWN 📉', pipValue: 0.10 },
  },

  STAKE:                   0.35,
  SIGNAL_TICKS_OUT:        20,
  WARNING_TICKS_OUT:       60,
  PROB_OVERRIDE_THRESHOLD: 80,
  SPIKE_DETECT_MULTIPLIER: 5,
  SIGNAL_COOLDOWN_MS:      15000,
  SUMMARY_HOUR:            21,
  SUMMARY_MINUTE:          0,
};

// ── Persistent memory ────────────────────────────────────────────────
const MEMORY_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '.', 'spike_memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      console.log('[MEMORY] Loaded:', JSON.stringify(data));
      return data;
    }
  } catch (e) { console.error('[MEMORY] Load error:', e.message); }
  return {};
}

function saveMemory() {
  try {
    const data = {};
    Object.keys(CONFIG.SYMBOLS).forEach(sym => {
      if (state[sym] && state[sym].spikeHistory.length > 0)
        data[sym] = state[sym].spikeHistory.slice(-20);
    });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[MEMORY] Save error:', e.message); }
}

// ── Session stats ────────────────────────────────────────────────────
let session = {
  startedAt: new Date(), signals: 0, wins: 0, losses: 0,
  missedSpikes: 0, totalPnl: 0, bestTrade: null, worstTrade: null,
  bySymbol: {
    'BOOM1000':  { signals: 0, wins: 0, losses: 0, pnl: 0 },
    'BOOM500':   { signals: 0, wins: 0, losses: 0, pnl: 0 },
    'CRASH1000': { signals: 0, wins: 0, losses: 0, pnl: 0 },
    'CRASH500':  { signals: 0, wins: 0, losses: 0, pnl: 0 },
  },
};

function recordWin(sym, pnl) {
  session.wins++; session.totalPnl += pnl;
  session.bySymbol[sym].wins++; session.bySymbol[sym].pnl += pnl;
  if (!session.bestTrade || pnl > session.bestTrade.pnl) session.bestTrade = { sym, pnl };
}
function recordLoss(sym, pnl) {
  session.losses++; session.totalPnl += pnl;
  session.bySymbol[sym].losses++; session.bySymbol[sym].pnl += pnl;
  if (!session.worstTrade || pnl < session.worstTrade.pnl) session.worstTrade = { sym, pnl };
}
function resetSession() {
  session = {
    startedAt: new Date(), signals: 0, wins: 0, losses: 0,
    missedSpikes: 0, totalPnl: 0, bestTrade: null, worstTrade: null,
    bySymbol: {
      'BOOM1000':  { signals: 0, wins: 0, losses: 0, pnl: 0 },
      'BOOM500':   { signals: 0, wins: 0, losses: 0, pnl: 0 },
      'CRASH1000': { signals: 0, wins: 0, losses: 0, pnl: 0 },
      'CRASH500':  { signals: 0, wins: 0, losses: 0, pnl: 0 },
    },
  };
}

// ── Adaptive spike estimator ─────────────────────────────────────────
function _randSpike(period, history) {
  if (history && history.length >= 3) {
    const recent = history.slice(-5);
    const avg    = recent.reduce((a, b) => a + b, 0) / recent.length;
    const spread = period * 0.20;
    return Math.max(30, Math.floor(avg - spread * 0.3 + Math.random() * spread));
  }
  return Math.floor(Math.random() * period * 0.30 + period * 0.60);
}

// ── State ────────────────────────────────────────────────────────────
const _savedMemory = loadMemory();
const state = {};
Object.keys(CONFIG.SYMBOLS).forEach(sym => {
  const s = CONFIG.SYMBOLS[sym];
  state[sym] = {
    prices: [], ticks: 0,
    nextSpike:      _randSpike(s.period, _savedMemory[sym] || []),
    rsi: 50, avgMove: 0,
    signalFired:    false, warnFired: false,
    lastSignalAt:   0, lastPrice: null, entryPrice: null,
    spikeHistory:   _savedMemory[sym] || [],
    openContractId: null,
    missedSpikes:   0,
    connected:      false, ws: null,
  };
});

// ── Deriv trading WebSocket ──────────────────────────────────────────
let tradeWs      = null;
let tradeWsReady = false;
let authorized   = false;
const pendingTrades = [];

function connectTradeWs() {
  if (!CONFIG.DERIV_API_TOKEN) {
    console.log('[TRADE] No API token — trading disabled, signals only');
    return;
  }

  tradeWs = new WebSocket(`${CONFIG.DERIV_WS}?app_id=${CONFIG.DERIV_APP_ID}`);

  tradeWs.on('open', () => {
    console.log('[TRADE WS] Connected — authorizing...');
    tradeWs.send(JSON.stringify({ authorize: CONFIG.DERIV_API_TOKEN }));
  });

  tradeWs.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.msg_type === 'authorize') {
        if (msg.error) {
          console.error('[TRADE] Auth failed:', msg.error.message);
          return;
        }
        authorized   = true;
        tradeWsReady = true;
        console.log('[TRADE] Authorized');
      }

      if (msg.msg_type === 'proposal') {
        tradeWs.send(JSON.stringify({ buy: msg.proposal.id, price: msg.proposal.ask_price }));
      }

    } catch (e) {}
  });

  tradeWs.on('close', () => setTimeout(connectTradeWs, 5000));
}

// ── Place trade ──────────────────────────────────────────────────────
function placeTrade(sym) {
  if (!tradeWsReady) return;

  const s = CONFIG.SYMBOLS[sym];
  const contractType = s.type === 'boom' ? 'TICKSHIGH' : 'TICKSLOW';

  tradeWs.send(JSON.stringify({
    proposal: 1,
    amount: CONFIG.STAKE,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    symbol: sym,
    duration: 1,
    duration_unit: 't',
  }));
}

// ── Telegram ─────────────────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML'
  });

  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
  });

  req.write(body);
  req.end();
}

// ── Simple tick test (shortened run) ─────────────────────────────────
function connectDeriv(sym) {
  const ws = new WebSocket(`${CONFIG.DERIV_WS}?app_id=${CONFIG.DERIV_APP_ID}`);

  ws.on('open', () => {
    console.log(`[WS] Connected ${sym}`);
    ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
  });

  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.msg_type === 'tick') {
      console.log(sym, msg.tick.quote);
    }
  });
}

// ── Start ────────────────────────────────────────────────────────────
console.log('Bot running with FULL TOKENS');

connectTradeWs();
Object.keys(CONFIG.SYMBOLS).forEach(sym => connectDeriv(sym));