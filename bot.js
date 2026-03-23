'use strict';

// ═══════════════════════════════════════════════════════════════════
//  BOOM & CRASH SPIKE DETECTOR — v2.1
//  Signals fire ~20 ticks before expected spike
//  Adaptive spike memory — learns real intervals over time
//  Includes SL ($1.50 risk) and TP (exit after spike confirmed)
//  Data: Deriv (Binary.com) WebSocket live ticks
//  Notifications: Telegram Bot API
// ═══════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const https     = require('https');

// ───────────────────────────────────────────────────────────────────
//  CONFIGURATION — edit these values to tune the bot
// ───────────────────────────────────────────────────────────────────
const CONFIG = {

  // ── Telegram ──────────────────────────────────────────────────────
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || 'YOUR_BOT_TOKEN_HERE',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE',

  // ── Deriv ─────────────────────────────────────────────────────────
  DERIV_APP_ID: process.env.DERIV_APP_ID || '1089',
  DERIV_WS:     'wss://ws.binaryws.com/websockets/v3',

  // ── Symbols ───────────────────────────────────────────────────────
  //   period   = nominal average ticks between spikes
  //   pipValue = approximate $ value per 1 point move (adjust for your lot)
  SYMBOLS: {
    'BOOM1000':  { label: 'Boom 1000',  type: 'boom',  period: 1000, direction: 'UP 📈',   pipValue: 0.10 },
    'BOOM500':   { label: 'Boom 500',   type: 'boom',  period: 500,  direction: 'UP 📈',   pipValue: 0.10 },
    'CRASH1000': { label: 'Crash 1000', type: 'crash', period: 1000, direction: 'DOWN 📉', pipValue: 0.10 },
    'CRASH500':  { label: 'Crash 500',  type: 'crash', period: 500,  direction: 'DOWN 📉', pipValue: 0.10 },
  },

  // ── Risk management ───────────────────────────────────────────────
  RISK_DOLLARS:  1.50,   // max $ risk per trade (your SL amount)
  TP_ON_SPIKE:   true,   // true = exit (TP) when spike is confirmed
  TP_TICKS:      null,   // set a number to use fixed TP ticks, null = exit on spike

  // ── Signal timing ─────────────────────────────────────────────────
  //   Signal fires when ticks remaining <= SIGNAL_TICKS_OUT
  //   OR when probability >= PROB_OVERRIDE_THRESHOLD (whichever comes first)
  SIGNAL_TICKS_OUT:       20,    // fire signal when this many ticks remain
  WARNING_TICKS_OUT:      60,    // fire early warning at this many ticks remaining
  PROB_OVERRIDE_THRESHOLD: 80,   // fire signal early if prob reaches this % (even outside window)
  SPIKE_DETECT_MULTIPLIER:  5,   // move must be X times avg move to count as spike

  // ── Cooldown between signals per symbol (ms) ──────────────────────
  SIGNAL_COOLDOWN_MS: 90000,
};

// ───────────────────────────────────────────────────────────────────
//  ADAPTIVE SPIKE ESTIMATOR
//  Uses real observed spike intervals once we have enough history
// ───────────────────────────────────────────────────────────────────
function _randSpike(period, history) {
  if (history && history.length >= 3) {
    // Average of last 5 real observed intervals
    const recent  = history.slice(-5);
    const avg     = recent.reduce((a, b) => a + b, 0) / recent.length;
    const spread  = period * 0.20;
    // Estimate slightly below observed avg so signal fires before spike
    return Math.max(30, Math.floor(avg - spread * 0.3 + Math.random() * spread));
  }
  // First cycle: conservative — 60% to 90% of nominal period
  return Math.floor(Math.random() * period * 0.30 + period * 0.60);
}

// ───────────────────────────────────────────────────────────────────
//  STATE — one object per symbol
// ───────────────────────────────────────────────────────────────────
const state = {};
Object.keys(CONFIG.SYMBOLS).forEach(sym => {
  const s = CONFIG.SYMBOLS[sym];
  state[sym] = {
    prices:        [],    // rolling price history (max 500)
    ticks:         0,     // ticks since last spike
    nextSpike:     _randSpike(s.period, []),
    rsi:           50,
    avgMove:       0,
    signalFired:   false,
    warnFired:     false,
    lastSignalAt:  0,
    lastPrice:     null,
    entryPrice:    null,  // price when signal fired (for SL/TP)
    spikeHistory:  [],    // real observed tick intervals — grows over time
    missedSpikes:  0,     // spikes that happened without a signal
    connected:     false,
    ws:            null,
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

  // 1. Tick proximity — opens from 40% of period, not just the last 20 ticks
  //    This means probability starts building much earlier
  const openAt  = st.nextSpike * 0.40;  // start counting from 40% through cycle
  const elapsed = Math.max(0, st.ticks - openAt);
  const window  = st.nextSpike - openAt;
  const rawProx = window > 0 ? Math.min(elapsed / window, 1) : 0;
  const proximityScore = Math.pow(rawProx, 1.5);

  // 2. RSI exhaustion
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
    proximityScore   * 0.60 +
    rsiScore         * 0.25 +
    compressionScore * 0.15
  ) * 100;

  return Math.min(parseFloat(prob.toFixed(1)), 99.9);
}

// ───────────────────────────────────────────────────────────────────
//  SL / TP CALCULATOR
// ───────────────────────────────────────────────────────────────────
function calcSLTP(sym, entryPrice) {
  const s = CONFIG.SYMBOLS[sym];

  const slDistance = CONFIG.RISK_DOLLARS / s.pipValue;
  const slPrice    = s.type === 'boom'
    ? (entryPrice - slDistance)
    : (entryPrice + slDistance);

  let tpNote = 'Exit when spike candle closes';
  let tpPrice = null;
  if (CONFIG.TP_TICKS !== null) {
    tpPrice = s.type === 'boom'
      ? (entryPrice + CONFIG.TP_TICKS * s.pipValue)
      : (entryPrice - CONFIG.TP_TICKS * s.pipValue);
    tpNote = `${tpPrice.toFixed(2)} (fixed ${CONFIG.TP_TICKS} ticks)`;
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
    chat_id:              CONFIG.TELEGRAM_CHAT_ID,
    text,
    parse_mode:           'HTML',
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

function buildSignalMessage(sym, prob, ticksLeft, entryPrice, sl, trigger) {
  const s   = CONFIG.SYMBOLS[sym];
  const st  = state[sym];
  const now = new Date().toUTCString();
  const emoji   = s.type === 'boom' ? '🚀' : '💥';
  const rsiNote = st.rsi < 30 ? ' (oversold ✅)' : st.rsi > 70 ? ' (overbought ✅)' : '';
  const tpLine  = `💰 <b>TP:</b> ${sl.tpNote}`;
  const triggerNote = trigger === 'prob'
    ? `⚡ High probability trigger (${prob}%)`
    : `⏱ Tick window trigger (~${ticksLeft} ticks left)`;

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
    `${tpLine}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ <b>Action:</b> ${s.type === 'boom' ? '🟢 BUY NOW' : '🔴 SELL NOW'}\n` +
    `<i>${triggerNote}</i>\n` +
    `🕐 <i>${now}</i>`
  );
}

function buildSpikeConfirmMessage(sym, move, avgMove, ticksAtSpike, entryPrice, hadSignal) {
  const s = CONFIG.SYMBOLS[sym];
  const pnlNote = (entryPrice && hadSignal)
    ? ` | Est. P&L: +$${(move * s.pipValue).toFixed(2)}`
    : '';
  const signalNote = hadSignal
    ? '<i>Close your trade if still open.</i>'
    : `<i>⚠️ No signal was sent this cycle — spike came at tick ${ticksAtSpike}. Bot has learned this interval.</i>`;

  return (
    `✅ <b>SPIKE CONFIRMED — ${s.label}</b>\n` +
    `Move: ${move.toFixed(3)} pts (${(move / avgMove).toFixed(1)}x avg)${pnlNote}\n` +
    `Ticks at spike: ${ticksAtSpike}\n` +
    signalNote
  );
}

function buildStartupMessage() {
  const syms   = Object.values(CONFIG.SYMBOLS).map(s => s.label).join(', ');
  const tpMode = CONFIG.TP_TICKS ? `Fixed ${CONFIG.TP_TICKS} ticks` : 'Exit on spike confirmation';
  return (
    `🤖 <b>Boom & Crash Spike Detector v2.1 — ONLINE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 <b>Monitoring:</b> ${syms}\n` +
    `⚡ <b>Signal fires at:</b> ~${CONFIG.SIGNAL_TICKS_OUT} ticks OR prob ≥ ${CONFIG.PROB_OVERRIDE_THRESHOLD}%\n` +
    `🛑 <b>SL risk per trade:</b> $${CONFIG.RISK_DOLLARS.toFixed(2)}\n` +
    `💰 <b>TP mode:</b> ${tpMode}\n` +
    `🧠 <b>Adaptive:</b> Bot learns real spike intervals over time\n` +
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

  // ── Update state ──────────────────────────────────────────────────
  st.prices.push(price);
  if (st.prices.length > 500) st.prices.shift();
  st.ticks++;
  st.rsi      = calcRSI(st.prices);
  st.avgMove  = calcAvgMove(st.prices);
  st.lastPrice = price;

  const prob       = calcProbability(sym);
  const ticksLeft  = Math.max(st.nextSpike - st.ticks, 0);
  const cooldownOk = now - st.lastSignalAt > CONFIG.SIGNAL_COOLDOWN_MS;
  const minTicks   = Math.floor(s.period * 0.30); // don't signal in first 30% of cycle

  // ── 1. SPIKE DETECTION (check first — before signal logic) ────────
  //    Real spike = price move > SPIKE_DETECT_MULTIPLIER × average move
  if (st.prices.length >= 2 && st.ticks > 30) {
    const move = Math.abs(price - st.prices[st.prices.length - 2]);
    if (move > st.avgMove * CONFIG.SPIKE_DETECT_MULTIPLIER) {

      // Record real interval into adaptive history
      st.spikeHistory.push(st.ticks);
      if (st.spikeHistory.length > 20) st.spikeHistory.shift();

      const hadSignal = st.signalFired;
      if (!hadSignal) st.missedSpikes++;

      console.log(
        `[SPIKE]  ${sym} | move=${move.toFixed(4)} | avg=${st.avgMove.toFixed(4)} | ` +
        `ticks=${st.ticks} | signal=${hadSignal ? 'YES' : 'MISSED'} | ` +
        `history=[${st.spikeHistory.join(',')}]`
      );

      sendTelegram(buildSpikeConfirmMessage(sym, move, st.avgMove, st.ticks, st.entryPrice, hadSignal));
      _resetState(sym);
      return;
    }
  }

  // ── 2. EARLY WARNING — fires at WARNING_TICKS_OUT ─────────────────
  if (
    ticksLeft <= CONFIG.WARNING_TICKS_OUT &&
    ticksLeft >  CONFIG.SIGNAL_TICKS_OUT  &&
    st.ticks  >  minTicks                 &&
    !st.warnFired                         &&
    cooldownOk
  ) {
    st.warnFired = true;
    console.log(`[WARN]   ${sym} | prob=${prob}% | ticksLeft=${ticksLeft}`);
    sendTelegram(buildWarningMessage(sym, prob, ticksLeft), true);
  }

  // ── 3. SPIKE SIGNAL — two triggers ───────────────────────────────
  //    A) Tick window: ticksLeft <= SIGNAL_TICKS_OUT
  //    B) Probability override: prob >= PROB_OVERRIDE_THRESHOLD (catches early spikes)
  const tickTrigger = ticksLeft <= CONFIG.SIGNAL_TICKS_OUT && ticksLeft > 0;
  const probTrigger = prob >= CONFIG.PROB_OVERRIDE_THRESHOLD && st.ticks > minTicks;

  if (
    (tickTrigger || probTrigger) &&
    !st.signalFired              &&
    cooldownOk
  ) {
    st.signalFired  = true;
    st.entryPrice   = price;
    st.lastSignalAt = now;
    const sl      = calcSLTP(sym, price);
    const trigger = probTrigger && !tickTrigger ? 'prob' : 'tick';
    console.log(
      `[SIGNAL] ${sym} | prob=${prob}% | ticksLeft=${ticksLeft} | ` +
      `trigger=${trigger} | entry=${price.toFixed(2)} | SL=${sl.slPrice.toFixed(2)}`
    );
    sendTelegram(buildSignalMessage(sym, prob, ticksLeft, price, sl, trigger));
  }

  // ── 4. SAFETY RESET — if we go 60% past expected window ──────────
  if (st.ticks > st.nextSpike * 1.6) {
    console.log(`[RESET]  ${sym} — passed window (ticks=${st.ticks}, expected=${st.nextSpike})`);
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
  console.log(`[STATE]  ${sym} reset | nextSpike estimated at ${st.nextSpike} ticks`);
}

// ───────────────────────────────────────────────────────────────────
//  DERIV WEBSOCKET — one persistent connection per symbol
// ───────────────────────────────────────────────────────────────────
function connectDeriv(sym) {
  const st = state[sym];

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

  ws.on('close', code => {
    st.connected = false;
    console.log(`[WS] ${sym} closed (${code}) — reconnecting in 5s`);
    setTimeout(() => connectDeriv(sym), 5000);
  });

  ws.on('error', err => {
    console.error(`[WS error] ${sym}:`, err.message);
    st.connected = false;
  });
}

// ───────────────────────────────────────────────────────────────────
//  STATUS HEARTBEAT — logs to console every 30s
// ───────────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    console.log('\n── STATUS ──────────────────────────────────────────');
    Object.keys(CONFIG.SYMBOLS).forEach(sym => {
      const st   = state[sym];
      const s    = CONFIG.SYMBOLS[sym];
      const prob = calcProbability(sym);
      const conn = st.connected ? '🟢' : '🔴';
      const mem  = st.spikeHistory.length > 0
        ? `mem=[${st.spikeHistory.slice(-3).join(',')}]`
        : 'mem=learning';
      console.log(
        `${conn} ${s.label.padEnd(12)} | ` +
        `ticks: ${String(st.ticks).padStart(4)}/${st.nextSpike} | ` +
        `RSI: ${String(st.rsi).padStart(5)} | ` +
        `prob: ${String(prob).padStart(4)}% | ` +
        `missed: ${st.missedSpikes} | ${mem}`
      );
    });
    console.log('────────────────────────────────────────────────────\n');
  }, 30000);
}

// ───────────────────────────────────────────────────────────────────
//  STARTUP
// ───────────────────────────────────────────────────────────────────
console.log('════════════════════════════════════════');
console.log('  Boom & Crash Spike Detector  v2.1');
console.log('════════════════════════════════════════');
console.log(`Symbols   : ${Object.keys(CONFIG.SYMBOLS).join(', ')}`);
console.log(`Signal at : ${CONFIG.SIGNAL_TICKS_OUT} ticks | prob override ≥ ${CONFIG.PROB_OVERRIDE_THRESHOLD}%`);
console.log(`SL risk   : $${CONFIG.RISK_DOLLARS}`);
console.log(`TP mode   : ${CONFIG.TP_TICKS ? CONFIG.TP_TICKS + ' ticks' : 'on spike confirmation'}`);
console.log('════════════════════════════════════════\n');

sendTelegram(buildStartupMessage());
startHeartbeat();

Object.keys(CONFIG.SYMBOLS).forEach((sym, i) => {
  setTimeout(() => connectDeriv(sym), i * 1500);
});

// ───────────────────────────────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ───────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  Object.values(state).forEach(st => {
    if (st.ws) try { st.ws.terminate(); } catch (_) {}
  });
  sendTelegram('🔴 <b>Spike Detector — OFFLINE</b>\nBot was manually stopped.');
  setTimeout(() => process.exit(0), 2000);
});

process.on('uncaughtException', err => {
  console.error('[Uncaught exception]', err);
  sendTelegram(`⚠️ <b>Bot error</b>\n<code>${err.message}</code>\nRailway will restart automatically.`);
});
