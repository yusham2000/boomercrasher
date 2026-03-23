'use strict';

// ═══════════════════════════════════════════════════════════════════
//  BOOM & CRASH SPIKE DETECTOR — v3.0
//  SQLite trade history + REST API for live dashboard
//  Adaptive spike memory, SL/TP, Telegram signals
// ═══════════════════════════════════════════════════════════════════

const WebSocket  = require('ws');
const https      = require('https');
const db         = require('./database');
const { startAPI } = require('./api');

// ───────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ───────────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || 'YOUR_BOT_TOKEN_HERE',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE',
  DERIV_APP_ID:     process.env.DERIV_APP_ID     || '1089',
  DERIV_WS:         'wss://ws.binaryws.com/websockets/v3',

  SYMBOLS: {
    'BOOM1000':  { label: 'Boom 1000',  type: 'boom',  period: 1000, direction: 'UP 📈',   pipValue: 0.10 },
    'BOOM500':   { label: 'Boom 500',   type: 'boom',  period: 500,  direction: 'UP 📈',   pipValue: 0.10 },
    'CRASH1000': { label: 'Crash 1000', type: 'crash', period: 1000, direction: 'DOWN 📉', pipValue: 0.10 },
    'CRASH500':  { label: 'Crash 500',  type: 'crash', period: 500,  direction: 'DOWN 📉', pipValue: 0.10 },
  },

  RISK_DOLLARS:            1.50,
  TP_TICKS:                null,   // null = exit on spike confirmation
  SIGNAL_TICKS_OUT:        20,
  WARNING_TICKS_OUT:       60,
  PROB_OVERRIDE_THRESHOLD: 80,
  SPIKE_DETECT_MULTIPLIER: 5,
  SIGNAL_COOLDOWN_MS:      90000,
};

// ───────────────────────────────────────────────────────────────────
//  ADAPTIVE SPIKE ESTIMATOR
// ───────────────────────────────────────────────────────────────────
function _randSpike(period, history) {
  if (history && history.length >= 3) {
    const recent = history.slice(-5);
    const avg    = recent.reduce((a, b) => a + b, 0) / recent.length;
    const spread = period * 0.20;
    return Math.max(30, Math.floor(avg - spread * 0.3 + Math.random() * spread));
  }
  return Math.floor(Math.random() * period * 0.30 + period * 0.60);
}

// ───────────────────────────────────────────────────────────────────
//  STATE
// ───────────────────────────────────────────────────────────────────
const state = {};
Object.keys(CONFIG.SYMBOLS).forEach(sym => {
  const s = CONFIG.SYMBOLS[sym];
  state[sym] = {
    prices:       [],
    ticks:        0,
    nextSpike:    _randSpike(s.period, []),
    rsi:          50,
    avgMove:      0,
    signalFired:  false,
    warnFired:    false,
    lastSignalAt: 0,
    lastPrice:    null,
    entryPrice:   null,
    spikeHistory: [],
    missedSpikes: 0,
    connected:    false,
    ws:           null,
  };
});

// ───────────────────────────────────────────────────────────────────
//  INDICATORS
// ───────────────────────────────────────────────────────────────────
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

function calcAvgMove(prices) {
  if (prices.length < 5) return 1;
  const recent = prices.slice(-50);
  let total = 0;
  for (let i = 1; i < recent.length; i++) total += Math.abs(recent[i] - recent[i - 1]);
  return total / (recent.length - 1);
}

// ───────────────────────────────────────────────────────────────────
//  PROBABILITY ENGINE
// ───────────────────────────────────────────────────────────────────
function calcProbability(sym) {
  const s  = CONFIG.SYMBOLS[sym];
  const st = state[sym];

  const openAt  = st.nextSpike * 0.40;
  const elapsed = Math.max(0, st.ticks - openAt);
  const window  = st.nextSpike - openAt;
  const rawProx = window > 0 ? Math.min(elapsed / window, 1) : 0;
  const proximityScore = Math.pow(rawProx, 1.5);

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

  let compressionScore = 0;
  if (st.prices.length >= 5) {
    const recent = st.prices.slice(-5);
    let downs = 0, ups = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] < recent[i - 1]) downs++; else ups++;
    }
    if (s.type === 'boom'  && downs >= 4) compressionScore = 1;
    else if (s.type === 'crash' && ups >= 4)  compressionScore = 1;
    else if (downs >= 3 || ups >= 3)           compressionScore = 0.5;
  }

  return Math.min(parseFloat(((proximityScore * 0.60 + rsiScore * 0.25 + compressionScore * 0.15) * 100).toFixed(1)), 99.9);
}

// ───────────────────────────────────────────────────────────────────
//  SL / TP
// ───────────────────────────────────────────────────────────────────
function calcSLTP(sym, entryPrice) {
  const s          = CONFIG.SYMBOLS[sym];
  const slDistance = CONFIG.RISK_DOLLARS / s.pipValue;
  const slPrice    = s.type === 'boom' ? entryPrice - slDistance : entryPrice + slDistance;
  let tpNote       = 'Exit when spike candle closes';
  let tpPrice      = null;
  if (CONFIG.TP_TICKS !== null) {
    tpPrice = s.type === 'boom'
      ? entryPrice + CONFIG.TP_TICKS * s.pipValue
      : entryPrice - CONFIG.TP_TICKS * s.pipValue;
    tpNote = `${tpPrice.toFixed(2)} (fixed ${CONFIG.TP_TICKS} ticks)`;
  }
  return { slDistance, slPrice, tpPrice, tpNote };
}

// ───────────────────────────────────────────────────────────────────
//  TELEGRAM
// ───────────────────────────────────────────────────────────────────
function sendTelegram(text, silent = false) {
  if (CONFIG.TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.log('[TELEGRAM]\n' + text + '\n');
    return;
  }
  const body = JSON.stringify({
    chat_id: CONFIG.TELEGRAM_CHAT_ID, text,
    parse_mode: 'HTML', disable_notification: silent,
  });
  const req = https.request({
    hostname: 'api.telegram.org',
    path:     `/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let data = '';
    res.on('data', c => (data += c));
    res.on('end', () => {
      try { const p = JSON.parse(data); if (!p.ok) console.error('[Telegram error]', p.description); }
      catch (_) {}
    });
  });
  req.on('error', err => console.error('[Telegram error]', err.message));
  req.write(body);
  req.end();
}

// ───────────────────────────────────────────────────────────────────
//  MESSAGE BUILDERS
// ───────────────────────────────────────────────────────────────────
function buildWarningMessage(sym, prob, ticksLeft) {
  const s = CONFIG.SYMBOLS[sym];
  return (
    `⚠️ <b>PATTERN FORMING — ${s.label}</b>\n` +
    `Probability: <b>${prob}%</b> | Ticks left: ~${ticksLeft}\n` +
    `RSI: ${state[sym].rsi} | Get ready for spike signal.`
  );
}

function buildSignalMessage(sym, prob, ticksLeft, entryPrice, sl, trigger) {
  const s   = CONFIG.SYMBOLS[sym];
  const st  = state[sym];
  const now = new Date().toUTCString();
  const emoji   = s.type === 'boom' ? '🚀' : '💥';
  const rsiNote = st.rsi < 30 ? ' (oversold ✅)' : st.rsi > 70 ? ' (overbought ✅)' : '';
  const triggerNote = trigger === 'prob'
    ? `⚡ High probability trigger (${prob}%)`
    : `⏱ Tick window (~${ticksLeft} ticks left)`;
  return (
    `${emoji} <b>SPIKE SIGNAL — ${s.label.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Direction:</b> ${s.direction}\n` +
    `📊 <b>Probability:</b> ${prob}%\n` +
    `🔢 <b>Progress:</b> ${st.ticks} / ~${st.nextSpike} ticks\n` +
    `📈 <b>RSI (14):</b> ${st.rsi}${rsiNote}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>Entry:</b> ~${entryPrice.toFixed(2)}\n` +
    `🛑 <b>SL:</b> ${sl.slPrice.toFixed(2)} (risk $${CONFIG.RISK_DOLLARS.toFixed(2)})\n` +
    `💰 <b>TP:</b> ${sl.tpNote}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <b>Action:</b> ${s.type === 'boom' ? '🟢 BUY NOW' : '🔴 SELL NOW'}\n` +
    `<i>${triggerNote}</i>\n` +
    `🕐 <i>${now}</i>`
  );
}

function buildSpikeConfirmMessage(sym, move, avgMove, ticksAtSpike, entryPrice, hadSignal) {
  const s       = CONFIG.SYMBOLS[sym];
  const pnlNote = entryPrice && hadSignal ? ` | Est. P&L: +$${(move * s.pipValue).toFixed(2)}` : '';
  const note    = hadSignal
    ? '<i>Close your trade if still open.</i>'
    : `<i>⚠️ No signal this cycle — spike at tick ${ticksAtSpike}. Interval recorded for learning.</i>`;
  return (
    `✅ <b>SPIKE CONFIRMED — ${s.label}</b>\n` +
    `Move: ${move.toFixed(3)} pts (${(move / avgMove).toFixed(1)}x avg)${pnlNote}\n` +
    `Ticks at spike: ${ticksAtSpike}\n${note}`
  );
}

// ───────────────────────────────────────────────────────────────────
//  TICK PROCESSOR
// ───────────────────────────────────────────────────────────────────
function processTick(sym, price) {
  const st  = state[sym];
  const s   = CONFIG.SYMBOLS[sym];
  const now = Date.now();

  st.prices.push(price);
  if (st.prices.length > 500) st.prices.shift();
  st.ticks++;
  st.rsi      = calcRSI(st.prices);
  st.avgMove  = calcAvgMove(st.prices);
  st.lastPrice = price;

  const prob       = calcProbability(sym);
  const ticksLeft  = Math.max(st.nextSpike - st.ticks, 0);
  const cooldownOk = now - st.lastSignalAt > CONFIG.SIGNAL_COOLDOWN_MS;
  const minTicks   = Math.floor(s.period * 0.30);

  // ── 1. SPIKE DETECTION ───────────────────────────────────────────
  if (st.prices.length >= 2 && st.ticks > 30) {
    const move = Math.abs(price - st.prices[st.prices.length - 2]);
    if (move > st.avgMove * CONFIG.SPIKE_DETECT_MULTIPLIER) {

      st.spikeHistory.push(st.ticks);
      if (st.spikeHistory.length > 20) st.spikeHistory.shift();

      const hadSignal = st.signalFired;
      if (!hadSignal) st.missedSpikes++;

      // ── Log spike to DB ────────────────────────────────────────
      db.logSpike({
        symbol:     sym,
        ticks:      st.ticks,
        move:       parseFloat(move.toFixed(4)),
        had_signal: hadSignal ? 1 : 0,
        logged_at:  now,
      });

      // ── Close open trade in DB ─────────────────────────────────
      if (hadSignal && st.entryPrice) {
        const outcome = 'win'; // spike confirmed = TP hit
        const pnl     = parseFloat((move * s.pipValue).toFixed(2));
        db.closeTrade({
          symbol:      sym,
          outcome,
          pnl_usd:     pnl,
          spike_move:  parseFloat(move.toFixed(4)),
          spike_ticks: st.ticks,
          closed_at:   now,
        });
      }

      console.log(`[SPIKE] ${sym} | move=${move.toFixed(4)} | ticks=${st.ticks} | signal=${hadSignal ? 'YES' : 'MISSED'}`);
      sendTelegram(buildSpikeConfirmMessage(sym, move, st.avgMove, st.ticks, st.entryPrice, hadSignal));
      _resetState(sym);
      return;
    }

    // ── Check SL hit (price moved against us past SL price) ───────
    if (st.signalFired && st.entryPrice) {
      const sl = calcSLTP(sym, st.entryPrice);
      const slHit = s.type === 'boom'
        ? price <= sl.slPrice
        : price >= sl.slPrice;

      if (slHit) {
        db.closeTrade({
          symbol:      sym,
          outcome:     'sl',
          pnl_usd:     -CONFIG.RISK_DOLLARS,
          spike_move:  0,
          spike_ticks: st.ticks,
          closed_at:   now,
        });
        sendTelegram(
          `🛑 <b>STOP LOSS HIT — ${s.label}</b>\n` +
          `Loss: -$${CONFIG.RISK_DOLLARS.toFixed(2)}\n` +
          `Entry: ${st.entryPrice.toFixed(2)} → SL: ${sl.slPrice.toFixed(2)}\n` +
          `<i>Trade closed. Waiting for next signal.</i>`
        );
        console.log(`[SL HIT] ${sym} | entry=${st.entryPrice} | sl=${sl.slPrice.toFixed(2)}`);
        _resetState(sym);
        return;
      }
    }
  }

  // ── 2. EARLY WARNING ─────────────────────────────────────────────
  if (
    ticksLeft <= CONFIG.WARNING_TICKS_OUT &&
    ticksLeft >  CONFIG.SIGNAL_TICKS_OUT  &&
    st.ticks  >  minTicks                 &&
    !st.warnFired && cooldownOk
  ) {
    st.warnFired = true;
    sendTelegram(buildWarningMessage(sym, prob, ticksLeft), true);
  }

  // ── 3. SPIKE SIGNAL ───────────────────────────────────────────────
  const tickTrigger = ticksLeft <= CONFIG.SIGNAL_TICKS_OUT && ticksLeft > 0;
  const probTrigger = prob >= CONFIG.PROB_OVERRIDE_THRESHOLD && st.ticks > minTicks;

  if ((tickTrigger || probTrigger) && !st.signalFired && cooldownOk) {
    st.signalFired  = true;
    st.entryPrice   = price;
    st.lastSignalAt = now;
    const sl      = calcSLTP(sym, price);
    const trigger = probTrigger && !tickTrigger ? 'prob' : 'tick';

    // ── Save trade to DB ───────────────────────────────────────────
    db.openTrade({
      symbol:       sym,
      direction:    s.type === 'boom' ? 'BUY' : 'SELL',
      entry_price:  price,
      sl_price:     sl.slPrice,
      tp_mode:      CONFIG.TP_TICKS ? `fixed_${CONFIG.TP_TICKS}` : 'spike_confirm',
      risk_usd:     CONFIG.RISK_DOLLARS,
      signal_prob:  prob,
      signal_tick:  st.ticks,
      opened_at:    now,
    });

    console.log(`[SIGNAL] ${sym} | prob=${prob}% | ticksLeft=${ticksLeft} | trigger=${trigger}`);
    sendTelegram(buildSignalMessage(sym, prob, ticksLeft, price, sl, trigger));
  }

  // ── 4. SAFETY RESET ───────────────────────────────────────────────
  if (st.ticks > st.nextSpike * 1.6) {
    console.log(`[RESET] ${sym} — passed window (ticks=${st.ticks})`);
    _resetState(sym);
  }
}

function _resetState(sym) {
  const s  = CONFIG.SYMBOLS[sym];
  const st = state[sym];
  st.ticks       = 0;
  st.nextSpike   = _randSpike(s.period, st.spikeHistory);
  st.signalFired = false;
  st.warnFired   = false;
  st.entryPrice  = null;
  console.log(`[STATE] ${sym} reset | nextSpike ~${st.nextSpike} ticks`);
}

// ───────────────────────────────────────────────────────────────────
//  DERIV WEBSOCKET
// ───────────────────────────────────────────────────────────────────
function connectDeriv(sym) {
  const st = state[sym];
  if (st.ws) try { st.ws.terminate(); } catch (_) {}

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
      if (msg.error) { console.error(`[Deriv] ${sym}:`, msg.error.message); return; }
      if (msg.msg_type === 'tick' && msg.tick) processTick(sym, parseFloat(msg.tick.quote));
    } catch (err) { console.error(`[Parse] ${sym}:`, err.message); }
  });

  ws.on('close', code => {
    st.connected = false;
    console.log(`[WS] ${sym} closed (${code}) — reconnecting in 5s`);
    setTimeout(() => connectDeriv(sym), 5000);
  });

  ws.on('error', err => { console.error(`[WS error] ${sym}:`, err.message); st.connected = false; });
}

// ───────────────────────────────────────────────────────────────────
//  HEARTBEAT
// ───────────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    console.log('\n── STATUS ─────────────────────────────────────────────');
    Object.keys(CONFIG.SYMBOLS).forEach(sym => {
      const st   = state[sym];
      const s    = CONFIG.SYMBOLS[sym];
      const prob = calcProbability(sym);
      const mem  = st.spikeHistory.length > 0 ? `[${st.spikeHistory.slice(-3).join(',')}]` : 'learning';
      console.log(
        `${st.connected ? '🟢' : '🔴'} ${s.label.padEnd(12)} | ` +
        `ticks: ${String(st.ticks).padStart(4)}/${st.nextSpike} | ` +
        `RSI: ${String(st.rsi).padStart(5)} | prob: ${String(prob).padStart(4)}% | ` +
        `missed: ${st.missedSpikes} | mem: ${mem}`
      );
    });
    const stats = db.getStats();
    console.log(`\n📊 Trades: ${stats.summary.total} | Wins: ${stats.summary.wins} | SL: ${stats.summary.losses} | WR: ${stats.summary.winRate}% | P&L: $${stats.summary.totalPnl}`);
    console.log('───────────────────────────────────────────────────────\n');
  }, 30000);
}

// ───────────────────────────────────────────────────────────────────
//  STARTUP
// ───────────────────────────────────────────────────────────────────
console.log('════════════════════════════════════════');
console.log('  Boom & Crash Spike Detector  v3.0');
console.log('════════════════════════════════════════');

startAPI();

const startupMsg =
  `🤖 <b>Boom & Crash Spike Detector v3.0 — ONLINE</b>\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `📡 Monitoring: Boom 1000, Boom 500, Crash 1000, Crash 500\n` +
  `⚡ Signal at: ~${CONFIG.SIGNAL_TICKS_OUT} ticks | prob ≥ ${CONFIG.PROB_OVERRIDE_THRESHOLD}%\n` +
  `🛑 SL risk: $${CONFIG.RISK_DOLLARS} per trade\n` +
  `🧠 Adaptive spike learning: ON\n` +
  `📊 Trade history: SQLite (persistent)\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `<i>Scanning for spike patterns...</i>`;

sendTelegram(startupMsg);
startHeartbeat();

Object.keys(CONFIG.SYMBOLS).forEach((sym, i) => {
  setTimeout(() => connectDeriv(sym), i * 1500);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  Object.values(state).forEach(st => { if (st.ws) try { st.ws.terminate(); } catch (_) {} });
  sendTelegram('🔴 <b>Spike Detector — OFFLINE</b>\nBot was stopped.');
  setTimeout(() => process.exit(0), 2000);
});

process.on('uncaughtException', err => {
  console.error('[Uncaught]', err);
  sendTelegram(`⚠️ <b>Bot error</b>\n<code>${err.message}</code>`);
});
