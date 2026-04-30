@echo off
echo ==========================================
echo    Writely Platform - Professional Launcher
echo ==========================================
echo.

echo [1/4] Closing previous sessions...
powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 5001).OwningProcess -Force" 2>nul
powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 8081).OwningProcess -Force" 2>nul

echo [2/4] Starting Writely Backend...
start /b cmd /c "cd gateway\api-gateway && node server.js"
timeout /t 5 /nobreak >nul

echo [3/4] Starting Writely Frontend...
start /b cmd /c "npx http-server ./ -p 8081"
timeout /t 3 /nobreak >nul

echo [4/4] Launching Writely in Browser...
start http://localhost:8081/apps/seeker-web/index.html

echo.
echo ==========================================
echo ✅ Writely is now RUNNING!
echo.
echo Backend: http://localhost:5001
echo Frontend: http://localhost:8081
echo.
echo DO NOT CLOSE THIS WINDOW while using Writely.
echo ==========================================
pause
