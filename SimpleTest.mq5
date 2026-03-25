//+------------------------------------------------------------------+
//|  SimpleTest.mq5                                                    |
//|  Minimal EA to debug the stopping issue                          |
//+------------------------------------------------------------------+
#property copyright "Test"
#property version   "1.00"
#property strict

int OnInit() {
   Print("SimpleTest EA started");
   Print("This EA should not stop");
   
   // Set timer to check every 10 seconds
   EventSetTimer(10);
   
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   Print("SimpleTest EA stopped - Reason: ", reason);
}

void OnTimer() {
   Print("Timer tick - EA is still running");
}

void OnTick() {
   // Do nothing
}
