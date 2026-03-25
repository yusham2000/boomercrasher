@echo off
echo ========================================
echo   Telegram Signal Reader for MT5
echo ========================================
echo.
echo Installing dependencies...
pip install -r requirements.txt
echo.
echo Starting Telegram reader...
echo.
python telegram_signal_reader.py
pause
