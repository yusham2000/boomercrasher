# 🚀 Boom & Crash Spike Detector v2.0

Monitors all 4 Boom & Crash indices via Deriv live ticks.
Sends Telegram signals ~20 ticks before the expected spike,
with Stop Loss and Take Profit levels included in every signal.

---

## 📁 File structure

```
boom-crash-bot/
├── bot.js           ← main bot (all logic lives here)
├── package.json     ← dependencies
├── railway.toml     ← Railway deployment config
├── .env.example     ← environment variable template
├── .gitignore
└── README.md
```

---

## ⚡ Quick setup (15 minutes)

### 1. Create your Telegram bot

1. Open Telegram → search **@BotFather**
2. Send `/newbot` → follow prompts
3. Copy your **bot token** e.g. `123456789:ABCdef...`

### 2. Get your Chat ID

1. Send any message to your new bot
2. Open in browser (replace TOKEN):
   ```
   https://api.telegram.org/botTOKEN/getUpdates
   ```
3. Find `"chat":{"id":XXXXXXXXX}` — copy that number

### 3. Push to GitHub

```bash
git init
git add .
git commit -m "boom crash bot v2"
git remote add origin https://github.com/YOUR_USERNAME/boom-crash-bot.git
git push -u origin main
```

### 4. Deploy free on Railway

1. Go to **https://railway.app** → sign up with GitHub (free)
2. Click **New Project** → **Deploy from GitHub repo** → select your repo
3. Go to **Variables** tab → add these 3 variables:

   | Key | Value |
   |-----|-------|
   | `TELEGRAM_TOKEN` | your token from step 1 |
   | `TELEGRAM_CHAT_ID` | your chat id from step 2 |
   | `DERIV_APP_ID` | `1089` |

4. Railway auto-deploys. Check **Logs** tab for:
   ```
   [WS] Connected — BOOM1000
   [WS] Connected — BOOM500
   ...
   ```
5. Your Telegram receives startup message ✅

---

## 📱 Signal messages

**Silent early warning (~60 ticks out):**
```
⚠️ PATTERN FORMING — Boom 1000
Probability: 44% | Ticks left: ~58
RSI: 37.2 | Get ready for spike signal.
```

**Spike signal (~20 ticks out):**
```
🚀 SPIKE SIGNAL — BOOM 1000
━━━━━━━━━━━━━━━━━━━━━━
🎯 Direction: UP 📈
📊 Probability: 81%
🕐 Ticks remaining: ~18
🔢 Progress: 982 / 1000 ticks
📈 RSI (14): 29.4 (oversold ✅)
━━━━━━━━━━━━━━━━━━━━━━
📌 Entry: ~1234.56
🛑 SL: 1233.06  (risk $1.50)
💰 TP: Exit when spike candle closes
━━━━━━━━━━━━━━━━━━━━━━
⚡ Action: 🟢 BUY NOW
```

**Spike confirmed:**
```
✅ SPIKE CONFIRMED — Boom 1000
Move: 14.230 pts (19.4x avg) | Est. P&L: +$1.42
Ticks at spike: 998
Close your trade if still open.
```

---

## 🛑 Stop loss explained

- `RISK_DOLLARS = 1.50` means max loss per trade is **$1.50**
- `SL_TICKS = 15` is the distance in ticks
- `pipValue = 0.10` means each 1-point move = $0.10 (adjust for your lot size)
- SL price = entry price ± (1.50 / 0.10) = 15 points away

**To adjust for your lot size**, change `pipValue` in `CONFIG.SYMBOLS` in `bot.js`.

---

## 💰 Take profit explained

Default: `TP_ON_SPIKE = true` → the bot sends a "close your trade" message
when the spike is detected. You exit manually on the spike candle.

To use fixed TP instead, change in `bot.js`:
```js
TP_TICKS: 50,  // exit 50 ticks after entry
```

---

## 🔧 Tuning options (in bot.js CONFIG section)

| Setting | Default | Effect |
|---------|---------|--------|
| `RISK_DOLLARS` | `1.50` | Max $ loss per trade |
| `SIGNAL_TICKS_OUT` | `20` | How early the signal fires |
| `WARNING_TICKS_OUT` | `60` | How early the warning fires |
| `SIGNAL_COOLDOWN_MS` | `90000` | Min time between signals per symbol (ms) |
| `TP_TICKS` | `null` | Fixed TP ticks (null = exit on spike) |
| `pipValue` | `0.10` | $ per 1 point move — adjust per lot |

---

## ⚠️ Disclaimer

This bot is for educational purposes. Boom & Crash spikes are
statistically random events. The bot identifies high-probability
windows — not guaranteed spike moments. Always use proper risk
management and never risk money you cannot afford to lose.
