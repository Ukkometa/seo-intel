@echo off
title SEO Intel
echo.
echo   Starting SEO Intel...
echo   Dashboard will open in your browser.
echo.
cd /d "%~dp0"
node cli.js serve --open
pause
