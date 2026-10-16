@echo off
title SynthOrg Orchestrator
cd /d "%~dp0"
rem While SynthOrg is being developed, what this starts is always what is on disk now.
rem The app may still be open from an earlier start - its window closed, kept running for the phone - and with it
rem the service, the desktop part and the editors of the pods as they were then, while the pages are read from disk
rem as they are now: half old, half new. So what is still open is closed first, with everything it started.
tasklist /FI "IMAGENAME eq synthorg.exe" 2>nul | find /I "synthorg.exe" >nul
if %errorlevel%==0 (
  echo SynthOrg e' ancora aperto da prima: lo chiudo e riparto da quello che c'e' adesso.
  taskkill /IM synthorg.exe /T /F >nul 2>&1
)
taskkill /IM synthorg-node.exe /F >nul 2>&1
rem What still serves the pages from an earlier start (a terminal left open on it).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":1430 .*LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1
rem In development the pages of the app can be looked at from this computer alone (127.0.0.1:9222), so that a change
rem is checked on the app that is really running. Not for a build that is given to others.
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
npm start
