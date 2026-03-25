//+------------------------------------------------------------------+
//|  SignalReceiver.mq5                                               |
//|  Working signal receiver based on SimpleTest                      |
//+------------------------------------------------------------------+
#property copyright "Boom Crash Bot"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

CTrade trade;
input double LotSize = 0.2;
input int MagicNumber = 20250323;

int OnInit() {
   trade.SetExpertMagicNumber(MagicNumber);
   Print("SignalReceiver EA started");
   Print("Ready to receive signals from file");
   
   EventSetTimer(1); // Check every 1 second
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   Print("SignalReceiver EA stopped - Reason: ", reason);
}

void OnTimer() {
   // Check for signal file in common folder
   string signal_file = TerminalInfoString(TERMINAL_DATA_PATH) + "\\MQL5\\Files\\signal.txt";
   
   if (FileIsExist(signal_file)) {
      int file_handle = FileOpen(signal_file, FILE_READ | FILE_TXT);
      if (file_handle != INVALID_HANDLE) {
         string signal = FileReadString(file_handle);
         FileClose(file_handle);
         FileDelete(signal_file);
         
         if (StringLen(signal) > 0) {
            Print("Signal received: ", signal);
            ExecuteSignal(signal);
         }
      }
   }
}

void ExecuteSignal(string signal) {
   string parts[];
   int count = StringSplit(signal, '|', parts);
   
   if (count < 3) {
      Print("Invalid signal format: ", signal);
      return;
   }
   
   string action = parts[0];
   string symbol = parts[1];
   double slPrice = StringToDouble(parts[2]);
   
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   
   bool success = false;
   
   if (action == "BUY") {
      Print("Placing BUY | ", symbol, " | SL=", slPrice);
      success = trade.Buy(LotSize, symbol, ask, slPrice, 0, "BoomCrashBot");
   } else if (action == "SELL") {
      Print("Placing SELL | ", symbol, " | SL=", slPrice);
      success = trade.Sell(LotSize, symbol, bid, slPrice, 0, "BoomCrashBot");
   }
   
   if (success) {
      Print("✅ Trade placed successfully | Ticket=", trade.ResultOrder());
   } else {
      Print("❌ Trade failed | Error=", trade.ResultRetcode());
   }
}

void OnTick() {
   // Nothing needed
}
