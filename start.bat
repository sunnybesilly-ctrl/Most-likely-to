@echo off
cd /d %~dp0
echo.
echo ===================================
echo   Setting things up (first time only)...
echo ===================================
call npm install
echo.
echo ===================================
echo   Starting the game server...
echo ===================================
start http://localhost:3000
call npm start
pause
