#!/usr/bin/env python3
"""
Telegram Signal Reader for MT5
Reads spike signals from Telegram and writes directly to MT5 named pipe
Replaces the PC server - no ngrok needed!
"""

import telebot
import win32file
import win32pipe
import winerror
import re
import time
import threading
from datetime import datetime

# ── CONFIGURATION ──────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = "8560354833:AAEAw967bUzoT69fAvWOhIR1QWoaNjTxVSk"
TELEGRAM_CHAT_ID = "5120084637" 
PIPE_NAME = r'\\.\pipe\BoomCrashSignal'

# ── INITIALIZATION ────────────────────────────────────────────────────
bot = telebot.TeleBot(TELEGRAM_BOT_TOKEN)
print(f"Telegram Signal Reader started")
print(f"Listening for signals in chat: {TELEGRAM_CHAT_ID}")
print(f"Writing to MT5 pipe: {PIPE_NAME}")
print("─" * 50)

def extract_signal_from_message(message_text):
    """Extract trade details from Telegram signal message"""
    
    # Look for signal pattern in message
    if "SPIKE SIGNAL" not in message_text:
        return None
        
    # Extract direction from message
    action = None
    if "BUY NOW" in message_text or "🟢 BUY" in message_text:
        action = "BUY"
    elif "SELL NOW" in message_text or "🔴 SELL" in message_text:
        action = "SELL"
    
    # Extract symbol from message
    symbol_match = re.search(r'SIGNAL — (BOOM\d+|CRASH\d+)', message_text)
    if symbol_match:
        symbol = symbol_match.group(1)
    else:
        return None
    
    # Extract SL price from message
    sl_match = re.search(r'SL: ([\d.]+)', message_text)
    if sl_match:
        sl_price = float(sl_match.group(1))
    else:
        return None
    
    return action, symbol, sl_price

def write_to_pipe(signal):
    """Write signal to MT5 via file (more reliable than pipe)"""
    try:
        # Use full path to MT5 data folder
        import os
        mt5_path = os.path.join(os.environ.get('APPDATA', ''), 'MetaQuotes', 'Terminal', 'common', 'Files')
        signal_file = os.path.join(mt5_path, 'signal.txt')
        
        # Create directory if it doesn't exist
        os.makedirs(mt5_path, exist_ok=True)
        
        # Write signal to file that MT5 EA will read
        with open(signal_file, 'w') as f:
            f.write(signal)
        
        print(f"✅ Signal written to file: {signal_file}")
        print(f"✅ Signal content: {signal}")
        return True
        
    except Exception as e:
        print(f"❌ File write error: {e}")
        return False

@bot.message_handler(func=lambda message: message.chat.id == int(TELEGRAM_CHAT_ID))
def handle_message(message):
    """Handle incoming Telegram messages"""
    
    # Only process signal messages
    if "SPIKE SIGNAL" not in message.text:
        return
    
    print(f"\n📨 Received signal at {datetime.now().strftime('%H:%M:%S')}")
    print(f"Message: {message.text[:100]}...")
    
    # Extract trade details
    signal_data = extract_signal_from_message(message.text)
    if not signal_data:
        print("❌ Could not extract signal data")
        return
    
    action, symbol, sl_price = signal_data
    
    # Format signal for MT5 (same format as original PC server)
    mt5_signal = f"{action}|{symbol}|{sl_price}"
    
    # Send to MT5
    success = write_to_pipe(mt5_signal)
    
    if success:
        # Send confirmation back to Telegram (optional)
        try:
            bot.reply_to(message, f"✅ Signal sent to MT5: {action} {symbol}")
        except:
            pass

def test_pipe_connection():
    """Test if MT5 pipe is available"""
    try:
        handle = win32file.CreateFile(
            PIPE_NAME,
            win32file.GENERIC_WRITE,
            0,
            None,
            win32file.OPEN_EXISTING,
            0,
            None
        )
        win32file.CloseHandle(handle)
        print("✅ MT5 pipe is ready")
        return True
    except Exception as e:
        print(f"❌ MT5 pipe not available: {e}")
        print("Make sure MT5 EA is running with 'BoomCrashAutoTrader'")
        return False

def main():
    """Main function"""
    
    # Check configuration
    if TELEGRAM_BOT_TOKEN == "YOUR_BOT_TOKEN_HERE":
        print("❌ Please update TELEGRAM_BOT_TOKEN with your bot token")
        return
    
    if TELEGRAM_CHAT_ID == "YOUR_CHAT_ID_HERE":
        print("❌ Please update TELEGRAM_CHAT_ID with your chat ID")
        return
    
    # Test pipe connection
    if not test_pipe_connection():
        print("\n🔧 To fix:")
        print("1. Make sure MT5 is open")
        print("2. Attach BoomCrashAutoTrader EA to any chart")
        print("3. Enable 'Allow live trading' in EA settings")
        print("4. Restart this script")
        return
    
    print("\n🚀 Ready to receive signals from Telegram!")
    print("Waiting for spike signals...")
    
    # Start polling for messages
    try:
        bot.polling(non_stop=True)
    except KeyboardInterrupt:
        print("\n👋 Stopped by user")
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    main()
