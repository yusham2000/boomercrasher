// ================= CONFIG =================
const DerivToken = "EJkPCsvw8y87Sra"; // Your Deriv API token
const TELEGRAM_TOKEN = "8560354833:AAEAw967bUzoT69fAvWOhIR1QWoaNjTxVSk"; // Telegram bot
const CHAT_ID = "5120084637"; // Telegram chat ID

const CONFIG = {
  STAKE: 0.2, // per trade
  MAX_RISK: 1.50, // max cumulative loss
  SYMBOLS: {
    "R_100": { type: "boom" },
    "R_25": { type: "crash" }
  }
};

// ============== STATE ===================
let currentLoss = 0;

// Telegram helper
const axios = require("axios");
function sendTelegram(message) {
  axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: message
  }).catch(console.error);
}

// ============== DERIV WS =================
const WebSocket = require("ws");
const tradeWs = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${DerivToken}`);

tradeWs.on("open", () => {
  console.log("[WS] Connected to Deriv");
  sendTelegram("Bot started ✅");
});

tradeWs.on("message", (msg) => {
  const data = JSON.parse(msg);

  // Listen to trade proposals or results
  if (data.proposal_open_contract) {
    const pnl = data.proposal_open_contract.profit; 
    if (pnl < 0) recordLoss(data.proposal_open_contract.underlying, pnl);
  }
});

// ============== TRADING =================
function placeTrade(sym) {
  if (currentLoss >= CONFIG.MAX_RISK) {
    console.log(`[TRADE] Max risk reached ($${currentLoss.toFixed(2)}), skipping trade.`);
    sendTelegram(`Max risk $${CONFIG.MAX_RISK} reached. No more trades today.`);
    return;
  }

  const s = CONFIG.SYMBOLS[sym];
  const contractType = s.type === 'boom' ? 'CALL' : 'PUT';

  const proposal = {
    proposal: 1,
    amount: CONFIG.STAKE,
    basis: "stake",
    contract_type: contractType,
    currency: "USD",
    symbol: sym,
    duration: 1,
    duration_unit: "t",
  };

  tradeWs.send(JSON.stringify(proposal));
  console.log(`[TRADE] Placing ${contractType} on ${sym} | stake $${CONFIG.STAKE}`);
  sendTelegram(`[TRADE] Placing ${contractType} on ${sym} | stake $${CONFIG.STAKE}`);
}

// Track losses
function recordLoss(sym, pnl) {
  currentLoss += Math.abs(pnl);
  console.log(`[LOSS] ${sym} | P&L: $${pnl.toFixed(2)} | Total loss: $${currentLoss.toFixed(2)}`);
  sendTelegram(`[LOSS] ${sym} | P&L: $${pnl.toFixed(2)} | Total loss: $${currentLoss.toFixed(2)}`);
}

// ============== EXAMPLE SIGNAL LOOP =============
setInterval(() => {
  // Example: simple signal generator
  if (currentLoss < CONFIG.MAX_RISK) {
    placeTrade("R_100");
    placeTrade("R_25");
  }
}, 5000); // every 5 seconds for demonstration