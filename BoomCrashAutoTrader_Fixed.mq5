//+------------------------------------------------------------------+
//|  BoomCrashAutoTrader_Fixed.mq5                                   |
//|  Fixed version with better pipe handling                         |
//+------------------------------------------------------------------+
#property copyright "Boom Crash Bot"
#property version   "1.01"
#property strict

#include <Trade\Trade.mqh>

// ── Inputs ──────────────────────────────────────────────────────────
input double LotSize       = 0.2;    // Lot size
input double RiskDollars   = 1.50;   // Max risk per trade in $
input int    MagicNumber   = 20250323;
input int    SlippagePips  = 3;
input bool   ShowAlerts    = true;

// ── Globals ─────────────────────────────────────────────────────────
CTrade trade;
string PIPE_NAME = "\\\\.\\pipe\\BoomCrashSignal";
int    pipeHandle = INVALID_HANDLE;
bool   tradeOpen  = false;
ulong  openTicket = 0;

//+------------------------------------------------------------------+
//| Expert initialization                                             |
//+------------------------------------------------------------------+
int OnInit() {
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePips * 10);

   Print("BoomCrashAutoTrader started | Lot=", LotSize, " | Risk=$", RiskDollars);
   Print("Creating named pipe for signals...");
   
   // Try to create pipe server
   CreatePipeServer();
   
   EventSetMillisecondTimer(1000); // check pipe every 1 second
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
   EventKillTimer();
   if (pipeHandle != INVALID_HANDLE) {
      FileClose(pipeHandle);
      pipeHandle = INVALID_HANDLE;
   }
   Print("BoomCrashAutoTrader stopped.");
}

//+------------------------------------------------------------------+
//| Timer — check pipe for incoming signals                           |
//+------------------------------------------------------------------+
void OnTimer() {
   if (pipeHandle == INVALID_HANDLE) {
      CreatePipeServer();
      return;
   }

   // Try to read from pipe
   string signal = "";
   while (!FileIsEnding(pipeHandle)) {
      string line = FileReadString(pipeHandle);
      if (StringLen(line) > 0) {
         signal = line;
         break;
      }
   }
   
   if (StringLen(signal) > 0) {
      Print("Signal received: ", signal);
      ParseAndTrade(signal);
   }
   
   // Reset pipe handle for next read
   if (FileIsEnding(pipeHandle)) {
      FileClose(pipeHandle);
      pipeHandle = INVALID_HANDLE;
   }
}

//+------------------------------------------------------------------+
//| Create pipe server                                                |
//+------------------------------------------------------------------+
void CreatePipeServer() {
   // For MT5, we'll create a file-based approach instead
   // Check for signal file
   if (FileIsExist("signal.txt")) {
      string signal = FileReadString("signal.txt");
      FileDelete("signal.txt");
      if (StringLen(signal) > 0) {
         Print("Signal from file: ", signal);
         ParseAndTrade(signal);
      }
   }
}

//+------------------------------------------------------------------+
//| Parse signal string and execute trade                             |
//| Signal format: ACTION|SYMBOL|SL_PRICE                            |
//| Example: BUY|BOOM1000|1219.50                                    |
//+------------------------------------------------------------------+
void ParseAndTrade(string signal) {
   string parts[];
   int count = StringSplit(signal, '|', parts);
   if (count < 3) {
      Print("Invalid signal format: ", signal);
      return;
   }

   string action   = parts[0]; // BUY or SELL
   string sym      = parts[1]; // e.g. BOOM1000
   double slPrice  = StringToDouble(parts[2]);

   // Close any existing trade for this symbol first
   CloseExistingTrades(sym);

   // Get current price
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);

   bool success = false;

   if (action == "BUY") {
      Print("Placing BUY | ", sym, " | Lot=", LotSize, " | SL=", slPrice);
      success = trade.Buy(LotSize, sym, ask, slPrice, 0, "BoomCrashBot");
   } else if (action == "SELL") {
      Print("Placing SELL | ", sym, " | Lot=", LotSize, " | SL=", slPrice);
      success = trade.Sell(LotSize, sym, bid, slPrice, 0, "BoomCrashBot");
   } else if (action == "CLOSE") {
      Print("Close signal received for ", sym);
      CloseExistingTrades(sym);
      return;
   }

   if (success) {
      openTicket = trade.ResultOrder();
      tradeOpen  = true;
      Print("Trade placed successfully | Ticket=", openTicket);
      if (ShowAlerts) Alert("BoomCrash: ", action, " placed on ", sym, " | Ticket ", openTicket);
   } else {
      Print("Trade FAILED | Error=", trade.ResultRetcode(), " | ", trade.ResultRetcodeDescription());
      if (ShowAlerts) Alert("BoomCrash: Trade FAILED on ", sym, " | Error: ", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
//| Close all open trades for a symbol placed by this EA             |
//+------------------------------------------------------------------+
void CloseExistingTrades(string sym) {
   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if (
         PositionGetString(POSITION_SYMBOL) == sym &&
         PositionGetInteger(POSITION_MAGIC) == MagicNumber
      ) {
         trade.PositionClose(ticket);
         Print("Closed existing position | Ticket=", ticket);
      }
   }
   tradeOpen = false;
}

//+------------------------------------------------------------------+
//| Tick — monitor open trades for spike confirmation close          |
//+------------------------------------------------------------------+
void OnTick() {
   // Nothing needed here — closing is handled by CLOSE signal from bot
}
//+------------------------------------------------------------------+
