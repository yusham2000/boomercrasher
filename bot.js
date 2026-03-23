'use strict';

// ═══════════════════════════════════════════════════════════════════
//  BOOM & CRASH SPIKE DETECTOR — v2.0
//  Signals fire ~20 ticks before expected spike
//  Includes SL ($1.50 risk) and TP (exit after spike confirmed)
//  Data: Deriv (Binary.com) WebSocket live ticks
//  Notifications: Telegram Bot API
// ═══════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');

// ───────────────────────────────────────────────────────────────────
//  CONFIGURATION — edit these values to tune the bot
// ───────────────────────────────────────────────────────────────────

// Validate required environment variables
function validateEnvironment() {
  const required = ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('Please set these in Railway → Variables tab');
    process.exit(1);
  }
}

validateEnvironment();

const CONFIG = {

  // ── Telegram ──────────────────────────────────────────────────────
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // ── Deriv ─────────────────────────────────────────────────────────
  DERIV_APP_ID: process.env.DERIV_APP_ID || '1089',
  DERIV_WS:     'wss://ws.binaryws.com/websockets/v3',

  // ── Symbols ───────────────────────────────────────────────────────
  //   period = average ticks between spikes
  //   pipValue = approximate $ value per 1 point move (adjust for your lot)
  SYMBOLS: {
    'BOOM1000':  { label: 'Boom 1000',  type: 'boom',  period: 1000, direction: 'UP 📈',   pipValue: 0.10 },
    'BOOM500':   { label: 'Boom 500',   type: 'boom',  period: 500,  direction: 'UP 📈',   pipValue: 0.10 },
    'CRASH1000': { label: 'Crash 1000', type: 'crash', period: 1000, direction: 'DOWN 📉', pipValue: 0.10 },
    'CRASH500':  { label: 'Crash 500',  type: 'crash', period: 500,  direction: 'DOWN 📉', pipValue: 0.10 },
  },

  // ── Risk management ───────────────────────────────────────────────
  RISK_DOLLARS:    1.50,   // max $ risk per trade (your SL amount)
  SL_TICKS:        15,     // stop loss distance in ticks from entry
  TP_ON_SPIKE:     true,   // true = exit (TP) when spike is confirmed
  TP_TICKS:        null,   // set a number to use fixed TP ticks, null = exit on spike

  // ── Signal timing ─────────────────────────────────────────────────
  SIGNAL_TICKS_OUT:   20,   // fire signal when this many ticks remain
  WARNING_TICKS_OUT:  60,   // fire early warning at this many ticks remaining

  // ── Cooldown between signals per symbol (ms) ──────────────────────
  SIGNAL_COOLDOWN_MS: 90000,
};

// ───────────────────────────────────────────────────────────────────
//  STATE — one object per symbol, holds all live tracking data
// ───────────────────────────────────────────────────────────────────
const state = {};
Object.keys(CONFIG.SYMBOLS).forEach(sym => {
  const s = CONFIG.SYMBOLS[sym];
  state[sym] = {
    prices:       [],        // rolling price history
    ticks:        0,         // ticks counted since last spike
    nextSpike:    _randSpike(s.period),  // estimated tick count of next spike
    rsi:          50,        // current RSI value
    avgMove:      0,         // rolling average tick move size
    signalFired:  false,     // true once signal sent this cycle
    warnFired:    false,     // true once warning sent this cycle
    lastSignalAt: 0,         // timestamp of last signal
    lastPrice:    null,      // most recent price
    entryPrice:   null,      // price at signal time (for SL/TP calc)
    connected:    false,
    ws:           null,
  };
});

function _randSpike(period) {
  return Math.floor(Math.random() * period * 0.4 + period * 0.7);
}

// ───────────────────────────────────────────────────────────────────
//  INDICATORS
// ───────────────────────────────────────────────────────────────────

// RSI — standard 14-period Wilder's RSI
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const slice = prices.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d;
    else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// Average absolute tick move (last 50 ticks)
function calcAvgMove(prices) {
  if (prices.length < 5) return 1;
  const recent = prices.slice(-50);
  let total = 0;
  for (let i = 1; i < recent.length; i++) {
    total += Math.abs(recent[i] - recent[i - 1]);
  }
  return total / (recent.length - 1);
}

// ───────────────────────────────────────────────────────────────────
//  SPIKE PROBABILITY ENGINE
//  Score = tick proximity (60%) + RSI exhaustion (25%) + compression (15%)
// ───────────────────────────────────────────────────────────────────
function calcProbability(sym) {
  const s  = CONFIG.SYMBOLS[sym];
  const st = state[sym];

  // 1. Tick proximity — curves sharply as we approach the expected spike
  const rawProx       = Math.min(st.ticks / st.nextSpike, 1);
  const proximityScore = Math.pow(rawProx, 1.8);

  // 2. RSI exhaustion — boom wants oversold, crash wants overbought
  const rsi = st.rsi;
  let rsiScore = 0;
  if (s.type === 'boom') {
    if (rsi < 30)      rsiScore = 1.0;
    else if (rsi < 45) rsiScore = 0.6;
    else if (rsi < 55) rsiScore = 0.2;
  } else {
    if (rsi > 70)      rsiScore = 1.0;
    else if (rsi > 55) rsiScore = 0.6;
    else if (rsi > 45) rsiScore = 0.2;
  }

  // 3. Candle compression — consecutive moves against spike direction
  let compressionScore = 0;
  if (st.prices.length >= 5) {
    const recent = st.prices.slice(-5);
    let downs = 0, ups = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] < recent[i - 1]) downs++;
      else ups++;
    }
    if (s.type === 'boom'  && downs >= 4) compressionScore = 1;
    else if (s.type === 'crash' && ups >= 4)  compressionScore = 1;
    else if (downs >= 3 || ups >= 3)           compressionScore = 0.5;
  }

  const prob = (
    proximityScore  * 0.60 +
    rsiScore        * 0.25 +
    compressionScore * 0.15
  ) * 100;

  return Math.min(parseFloat(prob.toFixed(1)), 99.9);
}

// ───────────────────────────────────────────────────────────────────
//  SL / TP CALCULATOR
//  SL distance in price = RISK_DOLLARS / pipValue
//  TP = exit on spike confirmation (or fixed ticks if set)
// ───────────────────────────────────────────────────────────────────
function calcSLTP(sym, entryPrice) {
  const s = CONFIG.SYMBOLS[sym];

  // SL distance: how many points before we lose $1.50
  const slDistance = CONFIG.RISK_DOLLARS / s.pipValue;
  const slPrice    = s.type === 'boom'
    ? (entryPrice - slDistance)   // boom = buy, SL below entry
    : (entryPrice + slDistance);  // crash = sell, SL above entry

  // TP: fixed ticks or "exit on spike" message
  let tpPrice = null;
  let tpNote  = 'Exit when spike candle closes (TP on confirmation)';
  if (CONFIG.TP_TICKS !== null) {
    tpPrice = s.type === 'boom'
      ? (entryPrice + CONFIG.TP_TICKS * s.pipValue)
      : (entryPrice - CONFIG.TP_TICKS * s.pipValue);
    tpNote  = `${tpPrice.toFixed(2)} (+${CONFIG.TP_TICKS} ticks)`;
  }

  return { slDistance, slPrice, tpPrice, tpNote };
}

// ───────────────────────────────────────────────────────────────────
//  TELEGRAM SENDER
// ───────────────────────────────────────────────────────────────────
function sendTelegram(text, silent = false) {
  if (
    CONFIG.TELEGRAM_TOKEN   === 'YOUR_BOT_TOKEN_HERE' ||
    CONFIG.TELEGRAM_CHAT_ID === 'YOUR_CHAT_ID_HERE'
  ) {
    console.log('[TELEGRAM — not configured]\n' + text + '\n');
    return;
  }

  const body = JSON.stringify({
    chat_id:             CONFIG.TELEGRAM_CHAT_ID,
    text,
    parse_mode:          'HTML',
    disable_notification: silent,
  });

  const req = https.request(
    {
      hostname: 'api.telegram.org',
      path:     `/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) console.error('[Telegram error]', parsed.description);
        } catch (_) {}
      });
    }
  );

  req.on('error', err => console.error('[Telegram request error]', err.message));
  req.write(body);
  req.end();
}

// ───────────────────────────────────────────────────────────────────
//  MESSAGE BUILDERS
// ───────────────────────────────────────────────────────────────────

function buildWarningMessage(sym, prob, ticksLeft) {
  const s  = CONFIG.SYMBOLS[sym];
  const st = state[sym];
  return (
    `⚠️ <b>PATTERN FORMING — ${s.label}</b>\n` +
    `Probability: <b>${prob}%</b> | Ticks left: ~${ticksLeft}\n` +
    `RSI: ${st.rsi} | Get ready for spike signal.`
  );
}

function buildSignalMessage(sym, prob, ticksLeft, entryPrice, sl) {
  const s   = CONFIG.SYMBOLS[sym];
  const st  = state[sym];
  const now = new Date().toUTCString();
  const emoji   = s.type === 'boom' ? '🚀' : '💥';
  const rsiNote = st.rsi < 30 ? ' (oversold ✅)' : st.rsi > 70 ? ' (overbought ✅)' : '';
  const tpLine  = CONFIG.TP_TICKS !== null
    ? `💰 <b>TP:</b> ${sl.tpNote}`
    : `💰 <b>TP:</b> Exit when spike candle closes`;

  return (
    `${emoji} <b>SPIKE SIGNAL — ${s.label.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Direction:</b> ${s.direction}\n` +
    `📊 <b>Probability:</b> ${prob}%\n` +
    `🕐 <b>Ticks remaining:</b> ~${ticksLeft}\n` +
    `🔢 <b>Progress:</b> ${st.ticks} / ${st.nextSpike} ticks\n` +
    `📈 <b>RSI (14):</b> ${st.rsi}${rsiNote}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>Entry:</b> ~${entryPrice.toFixed(2)}\n` +
    `🛑 <b>SL:</b> ${sl.slPrice.toFixed(2)} (risk $${CONFIG.RISK_DOLLARS.toFixed(2)})\n` +
    `${tpLine}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <b>Action:</b> ${s.type === 'boom' ? '🟢 BUY NOW' : '🔴 SELL NOW'}\n` +
    `🕐 <i>${now}</i>`
  );
}

function buildSpikeConfirmMessage(sym, move, avgMove, ticksAtSpike, entryPrice) {
  const s = CONFIG.SYMBOLS[sym];
  const pnlNote = entryPrice
    ? ` | Est. P&L: +$${(move * s.pipValue).toFixed(2)}`
    : '';
  return (
    `✅ <b>SPIKE CONFIRMED — ${s.label}</b>\n` +
    `Move: ${move.toFixed(3)} pts (${(move / avgMove).toFixed(1)}x avg)${pnlNote}\n` +
    `Ticks at spike: ${ticksAtSpike}\n` +
    `<i>Close your trade if still open.</i>`
  );
}

function buildStartupMessage() {
  const syms    = Object.values(CONFIG.SYMBOLS).map(s => s.label).join(', ');
  const tpMode  = CONFIG.TP_TICKS ? `Fixed ${CONFIG.TP_TICKS} ticks` : 'Exit on spike confirmation';
  return (
    `🤖 <b>Boom & Crash Spike Detector v2.0 — ONLINE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 <b>Monitoring:</b> ${syms}\n` +
    `⚡ <b>Signal fires at:</b> ~${CONFIG.SIGNAL_TICKS_OUT} ticks before spike\n` +
    `🛑 <b>SL risk per trade:</b> $${CONFIG.RISK_DOLLARS.toFixed(2)}\n` +
    `💰 <b>TP mode:</b> ${tpMode}\n` +
    `📊 <b>Data source:</b> Deriv live ticks\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Scanning for spike patterns...</i>`
  );
}

// ───────────────────────────────────────────────────────────────────
//  TICK PROCESSOR — runs on every incoming price tick
// ───────────────────────────────────────────────────────────────────
function processTick(sym, price) {
  const st  = state[sym];
  const s   = CONFIG.SYMBOLS[sym];
  const now = Date.now();

  // Update price history
  st.prices.push(price);
  if (st.prices.length > 500) st.prices.shift();
  st.ticks++;
  st.rsi      = calcRSI(st.prices);
  st.avgMove  = calcAvgMove(st.prices);
  st.lastPrice = price;

  const prob      = calcProbability(sym);
  const ticksLeft = Math.max(st.nextSpike - st.ticks, 0);
  const cooldownOk = now - st.lastSignalAt > CONFIG.SIGNAL_COOLDOWN_MS;

  // ── 1. EARLY WARNING — fires at WARNING_TICKS_OUT ─────────────────
  if (
    ticksLeft <= CONFIG.WARNING_TICKS_OUT &&
    ticksLeft >  CONFIG.SIGNAL_TICKS_OUT  &&
    !st.warnFired &&
    cooldownOk
  ) {
    st.warnFired = true;
    console.log(`[WARN]   ${sym} | prob=${prob}% | ticksLeft=${ticksLeft}`);
    sendTelegram(buildWarningMessage(sym, prob, ticksLeft), true); // silent notification
  }

  // ── 2. SPIKE SIGNAL — fires at SIGNAL_TICKS_OUT ───────────────────
  if (
    ticksLeft <= CONFIG.SIGNAL_TICKS_OUT &&
    ticksLeft >  0 &&
    !st.signalFired &&
    cooldownOk
  ) {
    st.signalFired  = true;
    st.entryPrice   = price;
    st.lastSignalAt = now;
    const sl = calcSLTP(sym, price);
    console.log(`[SIGNAL] ${sym} | prob=${prob}% | ticksLeft=${ticksLeft} | entry=${price} | SL=${sl.slPrice.toFixed(2)}`);
    sendTelegram(buildSignalMessage(sym, prob, ticksLeft, price, sl));
  }

  // ── 3. SPIKE DETECTION — real spike = move > 6x average ───────────
  if (st.prices.length >= 2 && st.ticks > 30) {
    const move = Math.abs(price - st.prices[st.prices.length - 2]);
    if (move > st.avgMove * 6) {
      console.log(`[SPIKE]  ${sym} | move=${move.toFixed(4)} | avg=${st.avgMove.toFixed(4)} | ticks=${st.ticks}`);
      sendTelegram(buildSpikeConfirmMessage(sym, move, st.avgMove, st.ticks, st.entryPrice));
      _resetState(sym);
      return;
    }
  }

  // ── 4. SAFETY RESET — past expected window by 50% ─────────────────
  if (st.ticks > st.nextSpike * 1.5) {
    console.log(`[RESET]  ${sym} — passed expected window (ticks=${st.ticks})`);
    _resetState(sym);
  }
}

function _resetState(sym) {
  const s  = CONFIG.SYMBOLS[sym];
  const st = state[sym];
  st.ticks       = 0;
  st.nextSpike   = _randSpike(s.period);
  st.signalFired = false;
  st.warnFired   = false;
  st.entryPrice  = null;
}

// ───────────────────────────────────────────────────────────────────
//  DERIV WEBSOCKET — one connection per symbol
// ───────────────────────────────────────────────────────────────────
function connectDeriv(sym) {
  const st = state[sym];

  // Clean up existing connection if any
  if (st.ws) {
    try { st.ws.terminate(); } catch (_) {}
  }

  const ws = new WebSocket(`${CONFIG.DERIV_WS}?app_id=${CONFIG.DERIV_APP_ID}`);
  st.ws = ws;

  ws.on('open', () => {
    st.connected = true;
    console.log(`[WS] Connected — ${sym}`);
    ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.error) {
        console.error(`[Deriv error] ${sym}:`, msg.error.message);
        return;
      }
      if (msg.msg_type === 'tick' && msg.tick) {
        processTick(sym, parseFloat(msg.tick.quote));
      }
    } catch (err) {
      console.error(`[Parse error] ${sym}:`, err.message);
    }
  });

  ws.on('close', (code, reason) => {
    st.connected = false;
    console.log(`[WS] ${sym} closed (${code}: ${reason || 'unknown'}) — reconnecting in 5s`);
    setTimeout(() => connectDeriv(sym), 5000);
  });

  ws.on('error', err => {
    console.error(`[WS error] ${sym}:`, err.message);
    st.connected = false;
    // Add exponential backoff for reconnection
    const delay = Math.min(30000, 5000 * Math.pow(2, st.reconnectAttempts || 0));
    st.reconnectAttempts = (st.reconnectAttempts || 0) + 1;
    setTimeout(() => connectDeriv(sym), delay);
  });

  // Add connection timeout
  ws.on('open', () => {
    st.reconnectAttempts = 0; // Reset on successful connection
  });

  setTimeout(() => {
    if (!st.connected && ws.readyState === WebSocket.CONNECTING) {
      console.log(`[WS] ${sym} connection timeout — forcing reconnect`);
      ws.terminate();
    }
  }, 10000); // 10 second timeout
}

// ───────────────────────────────────────────────────────────────────
//  STATUS HEARTBEAT — logs to console every 30s
// ───────────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    console.log('\n── STATUS ──────────────────────────────');
    Object.keys(CONFIG.SYMBOLS).forEach(sym => {
      const st   = state[sym];
      const s    = CONFIG.SYMBOLS[sym];
      const prob = calcProbability(sym);
      const conn = st.connected ? '🟢' : '🔴';
      console.log(
        `${conn} ${s.label.padEnd(12)} | ` +
        `ticks: ${String(st.ticks).padStart(4)}/${st.nextSpike} | ` +
        `RSI: ${String(st.rsi).padStart(5)} | ` +
        `prob: ${String(prob).padStart(4)}%`
      );
    });
    console.log('────────────────────────────────────────\n');
  }, 30000);
}

// ───────────────────────────────────────────────────────────────────
//  HEALTH CHECK SERVER — for Railway deployment monitoring
// ───────────────────────────────────────────────────────────────────
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      // Always return 200 - the app is running even if WebSockets are connecting
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        timestamp: new Date().toISOString(),
        connections: Object.keys(CONFIG.SYMBOLS).reduce((acc, sym) => {
          acc[sym] = state[sym].connected;
          return acc;
        }, {})
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`[Health] Server listening on port ${port}`);
  });
}

// ───────────────────────────────────────────────────────────────────
//  STARTUP
// ───────────────────────────────────────────────────────────────────
console.log('════════════════════════════════════════');
console.log('  Boom & Crash Spike Detector  v2.0');
console.log('════════════════════════════════════════');
console.log(`Symbols  : ${Object.keys(CONFIG.SYMBOLS).join(', ')}`);
console.log(`Signal at: ${CONFIG.SIGNAL_TICKS_OUT} ticks from spike`);
console.log(`SL risk  : $${CONFIG.RISK_DOLLARS}`);
console.log(`TP mode  : ${CONFIG.TP_TICKS ? CONFIG.TP_TICKS + ' ticks' : 'on spike confirmation'}`);
console.log('════════════════════════════════════════\n');

sendTelegram(buildStartupMessage());
startHeartbeat();
startHealthServer();

// Stagger connections by 1.5s each to avoid rate limiting
Object.keys(CONFIG.SYMBOLS).forEach((sym, i) => {
  setTimeout(() => connectDeriv(sym), i * 1500);
});

// ───────────────────────────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ───────────────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal} - shutting down gracefully...`);
  Object.values(state).forEach(st => {
    if (st.ws) try { st.ws.terminate(); } catch (_) {}
  });
  sendTelegram(`🔴 <b>Spike Detector — OFFLINE</b>\nBot stopped (${signal}).`);
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', err => {
  console.error('[Uncaught exception]', err);
  sendTelegram(`⚠️ <b>Bot error — restarting</b>\n<code>${err.message}</code>`);
  // Give Railway time to log the error before restart
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled rejection] at:', promise, 'reason:', reason);
  sendTelegram(`⚠️ <b>Bot rejection — restarting</b>\n<code>${reason}</code>`);
  setTimeout(() => process.exit(1), 1000);
});
