@echo off
title Hispace Portable Workspace
cd /d "%~dp0"

echo Starting Hispace Server...
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:3000"
"%~dp0node.exe" server.js

echo.
echo Server stopped. See the message above.
pause