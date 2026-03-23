'use strict';

// ═══════════════════════════════════════════════════════════════════
//  BOOM & CRASH SPIKE DETECTOR — v2.3
//  Auto-trades via PC server → MT5 EA
//  Adaptive spike memory + SL/TP + Daily summary
// ═══════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const https     = require('https');
const http      = require('http');

// ───────────────────────────────────────────────────────────────────
//  CONFIGURATION
// ───────────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || 'YOUR_BOT_TOKEN_HERE',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE',
  DERIV_APP_ID:     process.env.DERIV_APP_ID     || '1089',
  DERIV_WS:         'wss://ws.binaryws.com/websockets/v3',

  // ── Your PC public URL from ngrok ─────────────────────────────────
  // After starting ngrok, paste your URL here and redeploy
  // Example: 'https://abc123.ngrok-free.app'
  PC_SERVER_URL: process.env.PC_SERVER_URL || '',

  SYMBOLS: {
    'BOOM1000':  { label: 'Boom 1000',  type: 'boom',  period: 1000, direction: 'UP 📈',   pipValue: 0.10 },
    'BOOM500':   { label: 'Boom 500',   type: 'boom',  period: 500,  direction: 'UP 📈',   pipValue: 0.10 },
    'CRASH1000': { label: 'Crash 1000', type: 'crash', period: 1000, direction: 'DOWN 📉', pipValue: 0.10 },
    'CRASH500':  { label: 'Crash 500',  type: 'crash', period: 500,  direction: 'DOWN 📉', pipValue: 0.10 },
  },

  RISK_DOLLARS:            1.50,
  TP_TICKS:                null,
  SIGNAL_TICKS_OUT:        20,
  WARNING_TICKS_OUT:       60,
  PROB_OVERRIDE_THRESHOLD: 80,
  SPIKE_DETECT_MULTIPLIER: 5,
  SIGNAL_COOLDOWN_MS:      90000,

  SUMMARY_HOUR:   21,
  SUMMARY_MINUTE: 0,
};

// ───────────────────────────────────────────────────────────────────
//  SESSION STATS
// ───────────────────────────────────────────────────────────────────
let session = {
  startedAt:    new Date(),
  signals:      0,
  wins:         0,
  losses:       0,
  missedSpikes: 0,
  totalPnl:     0,
  bestTrade:    null,
  worstTrade:   null,
  bySymbol: {
    'BOOM1000':  { signals: 0, wins: 0, losses: 0, pnl: 0 },
    'BOOM500':   { signals: 0, wins: 0, losses: 0, pnl: 0 },
    'CRASH1000': { signals: 0, wins: 0, losses: 0, pnl: 0 },
    'CRASH500':  { signals: 0, wins: 0, losses: 0, pnl: 0 },
  },
};

function recordWin(sym, pnl) {
  session.wins++;
  session.totalPnl += pnl;
  session.bySymbol[sym].wins++;
  session.bySymbol[sym].pnl += pnl;
  if (!session.bestTrade || pnl > session.bestTrade.pnl)
    session.bestTrade = { sym, pnl };
}

function recordLoss(sym) {
  const pnl = -CONFIG.RISK_DOLLARS;
  session.losses++;
  session.totalPnl += pnl;
  session.bySymbol[sym].losses++;
  session.bySymbol[sym].pnl += pnl;
  if (!session.worstTrade || pnl < session.worstTrade.pnl)
    session.worstTrade = { sym, pnl };
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

// ───────────────────────────────────────────────────────────────────
//  PC SERVER — send trade commands to MT5 via your PC
// ───────────────────────────────────────────────────────────────────
function sendToPC(action, symbol, slPrice) {
  if (!CONFIG.PC_SERVER_URL) {
    console.log(`[PC] PC_SERVER_URL not set — skipping trade execution`);
    return;
  }

  const body    = JSON.stringify({ action, symbol, slPrice });
  const url     = new URL(CONFIG.PC_SERVER_URL);
  const isHttps = url.protocol === 'https:';
  const lib     = isHttps ? https : http;

  const options = {
    hostname: url.hostname,
    port:     url.port || (isHttps ? 443 : 80),
    path:     '/signal',
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const req = lib.request(options, res => {
    let data = '';
    res.on('data', c => (data += c));
    res.on('end', () => {
      console.log(`[PC] Response: ${data}`);
    });
  });

  req.on('error', err => {
    console.error(`[PC] Failed to reach PC server: ${err.message}`);
    sendTelegram(`⚠️ <b>PC server unreachable</b>\nCould not send ${action} for ${symbol}\nCheck ngrok and local server are running.`);
  });

  req.write(body);
  req.end();
  console.log(`[PC] Sent ${action} ${symbol} SL=${slPrice} to PC server`);
}

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
    prices: [], ticks: 0,
    nextSpike:    _randSpike(s.period, []),
    rsi: 50, avgMove: 0,
    signalFired: false, warnFired: false,
    lastSignalAt: 0, lastPrice: null, entryPrice: null,
    spikeHistory: [], connected: false, ws: null,
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
    if (d > 0) gains += d; else losses += Math.abs(d);
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
  const openAt         = st.nextSpike * 0.40;
  const elapsed        = Math.max(0, st.ticks - openAt);
  const window         = st.nextSpike - openAt;
  const rawProx        = window > 0 ? Math.min(elapsed / window, 1) : 0;
  const proximityScore = Math.pow(rawProx, 1.5);
  const rsi = st.rsi;
  let rsiScore = 0;
  if (s.type === 'boom') {
    if (rsi < 30) rsiScore = 1.0; else if (rsi < 45) rsiScore = 0.6; else if (rsi < 55) rsiScore = 0.2;
  } else {
    if (rsi > 70) rsiScore = 1.0; else if (rsi > 55) rsiScore = 0.6; else if (rsi > 45) rsiScore = 0.2;
  }
  let compressionScore = 0;
  if (st.prices.length >= 5) {
    const recent = st.prices.slice(-5);
    let downs = 0, ups = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] < recent[i - 1]) downs++; else ups++;
    }
    if (s.type === 'boom' && downs >= 4) compressionScore = 1;
    else if (s.type === 'crash' && ups >= 4) compressionScore = 1;
    else if (downs >= 3 || ups >= 3) compressionScore = 0.5;
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
  const tpNote     = 'Exit when spike candle closes';
  return { slDistance, slPrice, tpNote };
}

// ───────────────────────────────────────────────────────────────────
//  TELEGRAM
// ───────────────────────────────────────────────────────────────────
function sendTelegram(text, silent = false) {
  if (CONFIG.TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.log('[TELEGRAM]\n' + text + '\n'); return;
  }
  const body = JSON.stringify({
    chat_id: CONFIG.TELEGRAM_CHAT_ID, text,
    parse_mode: 'HTML', disable_notification: silent,
  });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let data = '';
    res.on('data', c => (data += c));
    res.on('end', () => {
      try { const p = JSON.parse(data); if (!p.ok) console.error('[Telegram]', p.description); } catch (_) {}
    });
  });
  req.on('error', err => console.error('[Telegram error]', err.message));
  req.write(body); req.end();
}

// ───────────────────────────────────────────────────────────────────
//  MESSAGES
// ───────────────────────────────────────────────────────────────────
function buildWarningMessage(sym, prob, ticksLeft) {
  const s = CONFIG.SYMBOLS[sym];
  return (
    `⚠️ <b>PATTERN FORMING — ${s.label}</b>\n` +
    `Probability: <b>${prob}%</b> | Ticks left: ~${ticksLeft}\n` +
    `RSI: ${state[sym].rsi} | Get ready — trade incoming.`
  );
}

function buildSignalMessage(sym, prob, ticksLeft, entryPrice, sl, trigger, autoTrade) {
  const s       = CONFIG.SYMBOLS[sym];
  const st      = state[sym];
  const now     = new Date().toUTCString();
  const emoji   = s.type === 'boom' ? '🚀' : '💥';
  const rsiNote = st.rsi < 30 ? ' (oversold ✅)' : st.rsi > 70 ? ' (overbought ✅)' : '';
  const tradeNote = autoTrade
    ? `🤖 <b>Auto-trade sent to MT5</b>`
    : `⚠️ <b>Manual trade needed</b> (PC server offline)`;
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
    `${tradeNote}\n` +
    `🕐 <i>${now}</i>`
  );
}

function buildSpikeConfirmMessage(sym, move, avgMove, ticksAtSpike, entryPrice, hadSignal) {
  const s       = CONFIG.SYMBOLS[sym];
  const pnlNote = entryPrice && hadSignal ? ` | Est. P&L: +$${(move * s.pipValue).toFixed(2)}` : '';
  const note    = hadSignal
    ? `<i>✅ Closing trade on MT5 now.</i>`
    : `<i>⚠️ No signal this cycle — spike at tick ${ticksAtSpike}.</i>`;
  return (
    `✅ <b>SPIKE CONFIRMED — ${s.label}</b>\n` +
    `Move: ${move.toFixed(3)} pts (${(move / avgMove).toFixed(1)}x avg)${pnlNote}\n` +
    `Ticks at spike: ${ticksAtSpike}\n${note}`
  );
}

function buildDailySummary() {
  const total   = session.wins + session.losses;
  const winRate = total > 0 ? ((session.wins / total) * 100).toFixed(1) : '0.0';
  const pnl     = session.totalPnl;
  const emoji   = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
  const symRows = Object.keys(CONFIG.SYMBOLS).map(sym => {
    const r  = session.bySymbol[sym];
    const s  = CONFIG.SYMBOLS[sym];
    const wr = (r.wins + r.losses) > 0 ? ((r.wins / (r.wins + r.losses)) * 100).toFixed(0) + '%' : '—';
    const p  = r.pnl >= 0 ? `+$${r.pnl.toFixed(2)}` : `-$${Math.abs(r.pnl).toFixed(2)}`;
    return `  ${s.label}: ${r.wins}W/${r.losses}L  WR:${wr}  ${p}`;
  }).join('\n');
  const bestLine  = session.bestTrade ? `🏆 Best:  +$${session.bestTrade.pnl.toFixed(2)} (${CONFIG.SYMBOLS[session.bestTrade.sym].label})` : '🏆 Best:  —';
  const worstLine = session.worstTrade ? `💔 Worst: -$${Math.abs(session.worstTrade.pnl).toFixed(2)} (${CONFIG.SYMBOLS[session.worstTrade.sym].label})` : '💔 Worst: —';
  return (
    `📊 <b>DAILY SUMMARY — ${new Date().toDateString()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${emoji} <b>Total P&L:</b> ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}\n` +
    `📈 <b>Win rate:</b> ${winRate}% (${session.wins}W / ${session.losses}L)\n` +
    `📡 <b>Signals:</b> ${session.signals} | 🛑 <b>SL hits:</b> ${session.losses}\n` +
    `⚠️ <b>Missed spikes:</b> ${session.missedSpikes}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>By symbol:</b>\n${symRows}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${bestLine}\n${worstLine}`
  );
}

// ───────────────────────────────────────────────────────────────────
//  DAILY SUMMARY SCHEDULER
// ───────────────────────────────────────────────────────────────────
function startDailySummary() {
  let lastSentDate = null;
  setInterval(() => {
    const now    = new Date();
    const today  = now.toDateString();
    if (now.getUTCHours() === CONFIG.SUMMARY_HOUR && now.getUTCMinutes() === CONFIG.SUMMARY_MINUTE && lastSentDate !== today) {
      lastSentDate = today;
      console.log('[SUMMARY] Sending daily summary');
      sendTelegram(buildDailySummary());
      setTimeout(() => resetSession(), 2000);
    }
  }, 60000);
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
  st.rsi       = calcRSI(st.prices);
  st.avgMove   = calcAvgMove(st.prices);
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

      if (hadSignal && st.entryPrice) {
        const pnl = parseFloat((move * s.pipValue).toFixed(2));
        recordWin(sym, pnl);
        // ── Close trade on MT5 ─────────────────────────────────────
        sendToPC('CLOSE', sym, 0);
      } else {
        session.missedSpikes++;
      }

      sendTelegram(buildSpikeConfirmMessage(sym, move, st.avgMove, st.ticks, st.entryPrice, hadSignal));
      _resetState(sym);
      return;
    }

    // ── SL check ────────────────────────────────────────────────────
    if (st.signalFired && st.entryPrice) {
      const sl    = calcSLTP(sym, st.entryPrice);
      const slHit = s.type === 'boom' ? price <= sl.slPrice : price >= sl.slPrice;
      if (slHit) {
        recordLoss(sym);
        sendToPC('CLOSE', sym, 0);
        sendTelegram(
          `🛑 <b>STOP LOSS HIT — ${s.label}</b>\n` +
          `Loss: -$${CONFIG.RISK_DOLLARS.toFixed(2)}\n` +
          `Entry: ${st.entryPrice.toFixed(2)} → SL: ${sl.slPrice.toFixed(2)}\n` +
          `<i>Trade closed on MT5.</i>`
        );
        _resetState(sym);
        return;
      }
    }
  }

  // ── 2. EARLY WARNING ─────────────────────────────────────────────
  if (
    ticksLeft <= CONFIG.WARNING_TICKS_OUT && ticksLeft > CONFIG.SIGNAL_TICKS_OUT &&
    st.ticks > minTicks && !st.warnFired && cooldownOk
  ) {
    st.warnFired = true;
    sendTelegram(buildWarningMessage(sym, prob, ticksLeft), true);
  }

  // ── 3. SPIKE SIGNAL ──────────────────────────────────────────────
  const tickTrigger = ticksLeft <= CONFIG.SIGNAL_TICKS_OUT && ticksLeft > 0;
  const probTrigger = prob >= CONFIG.PROB_OVERRIDE_THRESHOLD && st.ticks > minTicks;

  if ((tickTrigger || probTrigger) && !st.signalFired && cooldownOk) {
    st.signalFired  = true;
    st.entryPrice   = price;
    st.lastSignalAt = now;
    session.signals++;
    session.bySymbol[sym].signals++;

    const sl      = calcSLTP(sym, price);
    const trigger = probTrigger && !tickTrigger ? 'prob' : 'tick';

    // ── Send trade to MT5 via PC ───────────────────────────────────
    const action = s.type === 'boom' ? 'BUY' : 'SELL';
    const autoTrade = !!CONFIG.PC_SERVER_URL;
    if (autoTrade) sendToPC(action, sym, sl.slPrice);

    console.log(`[SIGNAL] ${sym} | prob=${prob}% | trigger=${trigger} | autoTrade=${autoTrade}`);
    sendTelegram(buildSignalMessage(sym, prob, ticksLeft, price, sl, trigger, autoTrade));
  }

  // ── 4. SAFETY RESET ──────────────────────────────────────────────
  if (st.ticks > st.nextSpike * 1.6) {
    _resetState(sym);
  }
}

function _resetState(sym) {
  const s  = CONFIG.SYMBOLS[sym];
  const st = state[sym];
  st.ticks = 0; st.nextSpike = _randSpike(s.period, st.spikeHistory);
  st.signalFired = false; st.warnFired = false; st.entryPrice = null;
  console.log(`[STATE] ${sym} reset | nextSpike ~${st.nextSpike}`);
}

// ───────────────────────────────────────────────────────────────────
//  DERIV WEBSOCKET
// ───────────────────────────────────────────────────────────────────
function connectDeriv(sym) {
  const st = state[sym];
  if (st.ws) try { st.ws.terminate(); } catch (_) {}
  const ws = new WebSocket(`${CONFIG.DERIV_WS}?app_id=${CONFIG.DERIV_APP_ID}`);
  st.ws = ws;
  ws.on('open', () => { st.connected = true; console.log(`[WS] Connected — ${sym}`); ws.send(JSON.stringify({ ticks: sym, subscribe: 1 })); });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.error) { console.error(`[Deriv] ${sym}:`, msg.error.message); return; }
      if (msg.msg_type === 'tick' && msg.tick) processTick(sym, parseFloat(msg.tick.quote));
    } catch (err) { console.error(`[Parse] ${sym}:`, err.message); }
  });
  ws.on('close', code => { st.connected = false; console.log(`[WS] ${sym} closed — reconnecting`); setTimeout(() => connectDeriv(sym), 5000); });
  ws.on('error', err => { console.error(`[WS error] ${sym}:`, err.message); st.connected = false; });
}

// ───────────────────────────────────────────────────────────────────
//  HEARTBEAT
// ───────────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    console.log('\n── STATUS ──────────────────────────────');
    Object.keys(CONFIG.SYMBOLS).forEach(sym => {
      const st = state[sym]; const s = CONFIG.SYMBOLS[sym];
      const prob = calcProbability(sym);
      console.log(`${st.connected ? '🟢' : '🔴'} ${s.label.padEnd(12)} | ticks: ${String(st.ticks).padStart(4)}/${st.nextSpike} | RSI: ${String(st.rsi).padStart(5)} | prob: ${String(prob).padStart(4)}%`);
    });
    const wr = (session.wins + session.losses) > 0 ? ((session.wins / (session.wins + session.losses)) * 100).toFixed(1) + '%' : '—';
    console.log(`📊 Today: ${session.signals} signals | ${session.wins}W/${session.losses}L | WR:${wr} | P&L:$${session.totalPnl.toFixed(2)}`);
    console.log('────────────────────────────────────────\n');
  }, 30000);
}

// ───────────────────────────────────────────────────────────────────
//  STARTUP
// ───────────────────────────────────────────────────────────────────
console.log('════════════════════════════════════════');
console.log('  Boom & Crash Spike Detector  v2.3');
console.log('════════════════════════════════════════');
console.log(`PC Server  : ${CONFIG.PC_SERVER_URL || 'NOT SET — manual trading only'}`);
console.log(`Summary at : ${CONFIG.SUMMARY_HOUR}:${String(CONFIG.SUMMARY_MINUTE).padStart(2,'0')} UTC`);
console.log('════════════════════════════════════════\n');

sendTelegram(
  `🤖 <b>Boom & Crash Spike Detector v2.3 — ONLINE</b>\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `📡 Monitoring: All 4 Boom & Crash indices\n` +
  `🤖 Auto-trade: ${CONFIG.PC_SERVER_URL ? '✅ Connected to MT5' : '⚠️ PC_SERVER_URL not set yet'}\n` +
  `🛑 SL risk: $${CONFIG.RISK_DOLLARS} per trade\n` +
  `📊 Daily summary: ${CONFIG.SUMMARY_HOUR}:${String(CONFIG.SUMMARY_MINUTE).padStart(2,'0')} UTC\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `<i>Scanning for spike patterns...</i>`
);

startDailySummary();
startHeartbeat();
Object.keys(CONFIG.SYMBOLS).forEach((sym, i) => setTimeout(() => connectDeriv(sym), i * 1500));

process.on('SIGINT', () => {
  sendTelegram(buildDailySummary());
  Object.values(state).forEach(st => { if (st.ws) try { st.ws.terminate(); } catch (_) {} });
  setTimeout(() => process.exit(0), 2000);
});
process.on('uncaughtException', err => {
  console.error('[Uncaught]', err);
  sendTelegram(`⚠️ <b>Bot error</b>\n<code>${err.message}</code>`);
});
