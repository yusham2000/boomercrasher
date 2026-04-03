'use strict';

// ═══════════════════════════════════════════════════════════════════
//  BOOM & CRASH ALL-IN-ONE BOT — v3.6
//  Detects spikes + Places trades directly on Deriv + Telegram alerts
//  Persistent memory across restarts + Daily summary
// ═══════════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');

const CONFIG = {
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || '8560354833:AAEAw967bUzoT69fAvWOhIR1QWoaNjTxVSk',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '5120084637',
  DERIV_APP_ID:     process.env.DERIV_APP_ID     || '1089',
  DERIV_API_TOKEN:  (process.env.DERIV_API_TOKEN || 'EJkPCsvw8y87Sra').replace(/^[^a-zA-Z0-9]+/, '').trim(),
  DERIV_WS:         'wss://ws.derivws.com/websockets/v3',

  SYMBOLS: {
    'BOOM1000':  { label: 'Boom 1000',  type: 'boom',  period: 1000, direction: 'UP 📈',   pipValue: 0.10 },
    'BOOM500':   { label: 'Boom 500',   type: 'boom',  period: 500,  direction: 'UP 📈',   pipValue: 0.10 },
    'CRASH1000': { label: 'Crash 1000', type: 'crash', period: 1000, direction: 'DOWN 📉', pipValue: 0.10 },
    'CRASH500':  { label: 'Crash 500',  type: 'crash', period: 500,  direction: 'DOWN 📉', pipValue: 0.10 },
  },

  STAKE:                   0.35,   // minimum Deriv stake
  RISK_DOLLARS:            1.50,   // max loss per trade ($1.50 SL)
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
    slPrice:        null,   // SL price level
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
    console.log('[TRADE] Token first 5 chars:', CONFIG.DERIV_API_TOKEN.substring(0, 5));
    tradeWs.send(JSON.stringify({ authorize: CONFIG.DERIV_API_TOKEN }));
  });

  tradeWs.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.msg_type === 'authorize') {
        if (msg.error) {
          console.error('[TRADE] Auth failed:', JSON.stringify(msg.error));
          sendTelegram(`⚠️ <b>Deriv auth failed</b>\nError: ${msg.error.message}\nCode: ${msg.error.code}`);
          return;
        }
        authorized   = true;
        tradeWsReady = true;
        const bal = msg.authorize.balance;
        const cur = msg.authorize.currency;
        console.log(`[TRADE] Authorized | Balance: ${bal} ${cur}`);
        sendTelegram(`✅ <b>Deriv trading authorized</b>\nBalance: ${bal} ${cur}\nReady to auto-trade!`);

        // Flush pending trades
        while (pendingTrades.length > 0) {
          const t = pendingTrades.shift();
          placeTrade(t.sym, t.entryPrice);
        }
      }

      if (msg.msg_type === 'buy') {
        if (msg.error) {
          console.error('[TRADE] Buy error full:', JSON.stringify(msg.error));
          sendTelegram(`⚠️ <b>Trade failed</b>\n${msg.error.message}`);
          return;
        }
        const c = msg.buy;
        console.log(`[TRADE] Opened | ID=${c.contract_id} | price=${c.buy_price}`);
        Object.keys(state).forEach(sym => {
          if (state[sym].signalFired && !state[sym].openContractId) {
            state[sym].openContractId = c.contract_id;
          }
        });
      }

      if (msg.msg_type === 'sell') {
        if (msg.error) { console.error('[TRADE] Sell error:', msg.error.message); return; }
        const sold = msg.sell;
        console.log(`[TRADE] Closed | ID=${sold.contract_id} | profit=${sold.sold_for}`);
      }

      if (msg.msg_type === 'proposal') {
        if (msg.error) {
          console.error('[TRADE] Proposal error full:', JSON.stringify(msg.error));
          return;
        }
        console.log(`[TRADE] Proposal received | id=${msg.proposal.id} | ask=${msg.proposal.ask_price} | payout=${msg.proposal.payout}`);
        const buyMsg = { buy: msg.proposal.id, price: msg.proposal.ask_price };
        console.log('[TRADE] Sending buy:', JSON.stringify(buyMsg));
        tradeWs.send(JSON.stringify(buyMsg));
      }

    } catch (e) { console.error('[TRADE WS parse]', e.message); }
  });

  tradeWs.on('close', () => {
    tradeWsReady = false;
    authorized   = false;
    console.log('[TRADE WS] Disconnected — reconnecting in 5s');
    setTimeout(connectTradeWs, 5000);
  });

  tradeWs.on('error', err => console.error('[TRADE WS]', err.message));
}

// ── Place trade ──────────────────────────────────────────────────────
function placeTrade(sym, entryPrice) {
  if (!CONFIG.DERIV_API_TOKEN) return;
  if (!tradeWsReady || !authorized) {
    console.log(`[TRADE] Not ready — queuing ${sym}`);
    pendingTrades.push({ sym, entryPrice });
    return;
  }
  const s            = CONFIG.SYMBOLS[sym];
  // Boom & Crash on Deriv web = Multipliers contract type
  // MULTUP = profit when price rises (Boom), MULTDOWN = profit when price falls (Crash)
  const contractType = s.type === 'boom' ? 'MULTUP' : 'MULTDOWN';
  console.log(`[TRADE] Placing ${contractType} on ${sym} stake=$${CONFIG.STAKE} | wsReady=${tradeWsReady} | auth=${authorized}`);
  const proposal = {
    proposal:      1,
    amount:        CONFIG.STAKE,
    basis:         'stake',
    contract_type: contractType,
    currency:      'USD',
    symbol:        sym,
    multiplier:    100,
  };
  console.log('[TRADE] Proposal request:', JSON.stringify(proposal));
  tradeWs.send(JSON.stringify(proposal));
}

// ── Close trade ──────────────────────────────────────────────────────
function closeTrade(sym) {
  const st = state[sym];
  if (!st.openContractId || !tradeWsReady) return;
  tradeWs.send(JSON.stringify({ sell: st.openContractId, price: 0 }));
  st.openContractId = null;
}

// ── RSI ──────────────────────────────────────────────────────────────
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

// ── Probability ──────────────────────────────────────────────────────
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
      if (recent[i] < recent[i-1]) downs++; else ups++;
    }
    if (s.type === 'boom' && downs >= 4) compressionScore = 1;
    else if (s.type === 'crash' && ups >= 4) compressionScore = 1;
    else if (downs >= 3 || ups >= 3) compressionScore = 0.5;
  }
  return Math.min(parseFloat(((proximityScore*0.60 + rsiScore*0.25 + compressionScore*0.15)*100).toFixed(1)), 99.9);
}

// ── Telegram ─────────────────────────────────────────────────────────
function sendTelegram(text, silent = false) {
  if (CONFIG.TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') { console.log('[TG]', text); return; }
  const body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_notification: silent });
  const req = https.request({
    hostname: 'api.telegram.org', path: `/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const p=JSON.parse(d); if(!p.ok) console.error('[TG]',p.description); }catch(_){} }); });
  req.on('error', e => console.error('[TG error]', e.message));
  req.write(body); req.end();
}

// ── Messages ─────────────────────────────────────────────────────────
function buildWarnMsg(sym, prob, ticksLeft) {
  const s = CONFIG.SYMBOLS[sym]; const st = state[sym];
  return `⚠️ <b>PATTERN FORMING — ${s.label}</b>\nProbability: <b>${prob}%</b> | Ticks left: ~${ticksLeft}\nRSI: ${st.rsi} | Trade incoming.`;
}

function buildSignalMsg(sym, prob, ticksLeft, entryPrice, trigger) {
  const s = CONFIG.SYMBOLS[sym]; const st = state[sym];
  const emoji   = s.type === 'boom' ? '🚀' : '💥';
  const rsiNote = st.rsi < 30 ? ' (oversold ✅)' : st.rsi > 70 ? ' (overbought ✅)' : '';
  const trigNote = trigger === 'prob' ? `⚡ High probability (${prob}%)` : `⏱ Tick window (~${ticksLeft} left)`;
  const tradeNote = CONFIG.DERIV_API_TOKEN ? '🤖 <b>Auto-trade placed on Deriv</b>' : '⚠️ No API token — manual trade needed';
  return (
    `${emoji} <b>SPIKE SIGNAL — ${s.label.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Direction:</b> ${s.direction}\n` +
    `📊 <b>Probability:</b> ${prob}%\n` +
    `🔢 <b>Progress:</b> ${st.ticks} / ~${st.nextSpike} ticks\n` +
    `📈 <b>RSI (14):</b> ${st.rsi}${rsiNote}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <b>Entry:</b> ~${entryPrice.toFixed(2)}\n` +
    `💰 <b>TP:</b> Exit when spike candle closes\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${tradeNote}\n` +
    `<i>${trigNote}</i>\n` +
    `🕐 <i>${new Date().toUTCString()}</i>`
  );
}

function buildSpikeConfirmMsg(sym, move, avgMove, ticksAtSpike, hadSignal, pnl) {
  const s = CONFIG.SYMBOLS[sym];
  const pnlNote = hadSignal && pnl !== null ? ` | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : '';
  const note = hadSignal
    ? `<i>✅ Trade closed automatically.</i>`
    : `<i>⚠️ No signal this cycle — spike at tick ${ticksAtSpike}. Interval learned.</i>`;
  return `✅ <b>SPIKE CONFIRMED — ${s.label}</b>\nMove: ${move.toFixed(3)} pts (${(move/avgMove).toFixed(1)}x avg)${pnlNote}\nTicks: ${ticksAtSpike}\n${note}`;
}

function buildDailySummary() {
  const total = session.wins + session.losses;
  const wr    = total > 0 ? ((session.wins/total)*100).toFixed(1) : '0.0';
  const pnl   = session.totalPnl;
  const symRows = Object.keys(CONFIG.SYMBOLS).map(sym => {
    const r = session.bySymbol[sym]; const s = CONFIG.SYMBOLS[sym];
    const w = (r.wins+r.losses)>0 ? ((r.wins/(r.wins+r.losses))*100).toFixed(0)+'%' : '—';
    return `  ${s.label}: ${r.wins}W/${r.losses}L  WR:${w}  ${r.pnl>=0?'+':''}$${r.pnl.toFixed(2)}`;
  }).join('\n');
  return (
    `📊 <b>DAILY SUMMARY — ${new Date().toDateString()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${pnl>=0?'🟢':'🔴'} <b>Total P&L:</b> ${pnl>=0?'+':''}$${Math.abs(pnl).toFixed(2)}\n` +
    `📈 <b>Win rate:</b> ${wr}% (${session.wins}W / ${session.losses}L)\n` +
    `📡 <b>Signals:</b> ${session.signals} | ⚠️ <b>Missed:</b> ${session.missedSpikes}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>By symbol:</b>\n${symRows}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${session.bestTrade  ? `🏆 Best:  +$${session.bestTrade.pnl.toFixed(2)} (${CONFIG.SYMBOLS[session.bestTrade.sym].label})`  : '🏆 Best:  —'}\n` +
    `${session.worstTrade ? `💔 Worst: $${session.worstTrade.pnl.toFixed(2)} (${CONFIG.SYMBOLS[session.worstTrade.sym].label})` : '💔 Worst: —'}`
  );
}

function startDailySummary() {
  let lastSentDate = null;
  setInterval(() => {
    const now = new Date(); const today = now.toDateString();
    if (now.getUTCHours()===CONFIG.SUMMARY_HOUR && now.getUTCMinutes()===CONFIG.SUMMARY_MINUTE && lastSentDate!==today) {
      lastSentDate = today;
      sendTelegram(buildDailySummary());
      setTimeout(() => resetSession(), 2000);
    }
  }, 60000);
}

// ── Tick processor ───────────────────────────────────────────────────
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
      saveMemory();

      const hadSignal = st.signalFired;
      if (!hadSignal) session.missedSpikes++;

      if (hadSignal && st.openContractId) closeTrade(sym);

      const pnl = hadSignal ? parseFloat((move * s.pipValue).toFixed(2)) : null;
      if (hadSignal && pnl) recordWin(sym, pnl);

      console.log(`[SPIKE] ${sym} | move=${move.toFixed(4)} | ticks=${st.ticks} | signal=${hadSignal?'YES':'MISSED'}`);
      sendTelegram(buildSpikeConfirmMsg(sym, move, st.avgMove, st.ticks, hadSignal, pnl));
      _resetState(sym);
      return;
    }
  }


  // ── SL CHECK ────────────────────────────────────────────────────
  if (st.signalFired && st.slPrice !== null) {
    const slHit = s.type === 'boom' ? price <= st.slPrice : price >= st.slPrice;
    if (slHit) {
      console.log(`[SL HIT] ${sym} | price=${price} | slPrice=${st.slPrice}`);
      const loss = -CONFIG.RISK_DOLLARS;
      recordLoss(sym, loss);
      if (st.openContractId) closeTrade(sym);
      sendTelegram(
        `🛑 <b>STOP LOSS HIT — ${s.label}</b>\n` +
        `Loss: -$${CONFIG.RISK_DOLLARS.toFixed(2)}\n` +
        `Entry: ${st.entryPrice.toFixed(2)} → SL: ${st.slPrice.toFixed(2)}\n` +
        `<i>Trade closed automatically.</i>`
      );
      _resetState(sym);
      return;
    }
  }

  // ── 2. WARNING ───────────────────────────────────────────────────
  if (ticksLeft <= CONFIG.WARNING_TICKS_OUT && ticksLeft > CONFIG.SIGNAL_TICKS_OUT &&
      st.ticks > minTicks && !st.warnFired && cooldownOk) {
    st.warnFired = true;
    sendTelegram(buildWarnMsg(sym, prob, ticksLeft), true);
  }

  // ── 3. SIGNAL + TRADE ────────────────────────────────────────────
  const tickTrigger = ticksLeft <= CONFIG.SIGNAL_TICKS_OUT && ticksLeft > 0;
  const probTrigger = prob >= CONFIG.PROB_OVERRIDE_THRESHOLD && st.ticks > minTicks;

  if ((tickTrigger || probTrigger) && !st.signalFired && cooldownOk) {
    st.signalFired  = true;
    st.entryPrice   = price;
    st.lastSignalAt = now;
    session.signals++;
    session.bySymbol[sym].signals++;

    const trigger  = probTrigger && !tickTrigger ? 'prob' : 'tick';
    // Calculate SL price — $1.50 risk / $0.10 per point = 15 points away
    const slDist   = CONFIG.RISK_DOLLARS / s.pipValue;
    st.slPrice     = s.type === 'boom' ? price - slDist : price + slDist;
    placeTrade(sym, price);

    console.log(`[SIGNAL] ${sym} | prob=${prob}% | ticks=${st.ticks} | trigger=${trigger}`);
    sendTelegram(buildSignalMsg(sym, prob, ticksLeft, price, trigger));
  }

  // ── 4. SAFETY RESET ─────────────────────────────────────────────
  if (st.ticks > st.nextSpike * 1.6) {
    _resetState(sym);
  }
}

function _resetState(sym) {
  const s = CONFIG.SYMBOLS[sym]; const st = state[sym];
  st.ticks = 0; st.nextSpike = _randSpike(s.period, st.spikeHistory);
  st.signalFired = false; st.warnFired = false;
  st.entryPrice = null; st.openContractId = null; st.slPrice = null;
  console.log(`[STATE] ${sym} reset | nextSpike ~${st.nextSpike}`);
}

// ── Deriv tick WebSocket ─────────────────────────────────────────────
// Each symbol gets its own WS connection — subscribe after connect
function connectDeriv(sym) {
  const st = state[sym];
  if (st.ws) try { st.ws.terminate(); } catch (_) {}

  const ws = new WebSocket(`${CONFIG.DERIV_WS}?app_id=${CONFIG.DERIV_APP_ID}`);
  st.ws = ws;

  ws.on('open', () => {
    st.connected = true;
    console.log(`[WS] Connected — ${sym}`);
    // If we have an API token, authorize first then subscribe
    if (CONFIG.DERIV_API_TOKEN) {
      ws.send(JSON.stringify({ authorize: CONFIG.DERIV_API_TOKEN }));
    } else {
      ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
    }
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.error) {
        console.error(`[Deriv] ${sym}:`, msg.error.message);
        return;
      }
      // After auth on tick WS, subscribe to ticks
      if (msg.msg_type === 'authorize') {
        ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
      }
      if (msg.msg_type === 'tick' && msg.tick) {
        processTick(sym, parseFloat(msg.tick.quote));
      }
    } catch (e) { console.error(`[Parse] ${sym}:`, e.message); }
  });

  ws.on('close', code => {
    st.connected = false;
    console.log(`[WS] ${sym} closed — reconnecting in 5s`);
    setTimeout(() => connectDeriv(sym), 5000);
  });
  ws.on('error', err => { console.error(`[WS] ${sym}:`, err.message); st.connected = false; });
}

// ── Heartbeat ────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    console.log('\n── STATUS ──────────────────────────────');
    Object.keys(CONFIG.SYMBOLS).forEach(sym => {
      const st = state[sym]; const s = CONFIG.SYMBOLS[sym];
      const prob = calcProbability(sym);
      const mem  = st.spikeHistory.length > 0 ? `[${st.spikeHistory.slice(-3).join(',')}]` : 'learning';
      console.log(`${st.connected?'🟢':'🔴'} ${s.label.padEnd(12)} | ticks: ${String(st.ticks).padStart(4)}/${st.nextSpike} | RSI: ${String(st.rsi).padStart(5)} | prob: ${String(prob).padStart(4)}% | mem: ${mem}`);
    });
    const wr = (session.wins+session.losses)>0 ? ((session.wins/(session.wins+session.losses))*100).toFixed(1)+'%' : '—';
    console.log(`📊 Today: ${session.signals} signals | ${session.wins}W/${session.losses}L | WR:${wr} | P&L:$${session.totalPnl.toFixed(2)}`);
    console.log('────────────────────────────────────────\n');
  }, 30000);
}

// ── Startup ──────────────────────────────────────────────────────────
console.log('════════════════════════════════════════');
console.log('  Boom & Crash All-in-One Bot  v3.6');
console.log('════════════════════════════════════════');
console.log(`Trading  : ${CONFIG.DERIV_API_TOKEN ? 'Deriv API ✅' : 'Disabled — no token'}`);
console.log(`Stake    : $${CONFIG.STAKE} per trade`);
console.log(`Memory   : ${Object.keys(_savedMemory).length} symbols loaded from disk`);
console.log('════════════════════════════════════════\n');

sendTelegram(
  `🤖 <b>Boom & Crash All-in-One Bot v3.6 — ONLINE</b>\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `📡 Monitoring: All 4 Boom & Crash indices\n` +
  `🤖 Auto-trade: ${CONFIG.DERIV_API_TOKEN ? '✅ Deriv API connected' : '⚠️ No API token — signals only'}\n` +
  `💰 Stake: $${CONFIG.STAKE} per trade\n` +
  `🧠 Memory: ${Object.keys(_savedMemory).length > 0 ? '✅ Loaded from disk' : 'Starting fresh'}\n` +
  `📊 Daily summary: ${CONFIG.SUMMARY_HOUR}:00 UTC\n` +
  `━━━━━━━━━━━━━━━━━━━━━━\n` +
  `<i>Scanning for spike patterns...</i>`
);

startDailySummary();
startHeartbeat();
if (CONFIG.DERIV_API_TOKEN) connectTradeWs();
Object.keys(CONFIG.SYMBOLS).forEach((sym, i) => setTimeout(() => connectDeriv(sym), i * 1500));

process.on('SIGINT', () => {
  sendTelegram(buildDailySummary());
  Object.values(state).forEach(st => { if (st.ws) try { st.ws.terminate(); } catch (_) {} });
  if (tradeWs) try { tradeWs.terminate(); } catch (_) {}
  setTimeout(() => process.exit(0), 2000);
});
process.on('uncaughtException', err => {
  console.error('[Uncaught]', err);
  sendTelegram(`⚠️ <b>Bot error</b>\n<code>${err.message}</code>`);
});