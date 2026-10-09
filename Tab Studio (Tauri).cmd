@echo off
rem Tauri version of Tab Studio (built with: pnpm tauri build --no-bundle)
if not exist "%~dp0src-tauri	argetelease	ab-studio.exe" (
  echo Tauri版はまだ作られていません。
  pause
  exit /b 1
)
start "Tab Studio Tauri" "%~dp0src-tauri	argetelease	ab-studio.exe"
