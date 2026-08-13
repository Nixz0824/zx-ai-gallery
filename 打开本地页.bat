@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue; if ($c) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  start "ZHANG XIN" /min python "%~dp0server.py"
  timeout /t 1 /nobreak >nul
)

start "" "http://127.0.0.1:8765"
