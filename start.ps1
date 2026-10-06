# Starts Khmer AI Dubber at http://127.0.0.1:5000 (builds first if needed)
Set-Location $PSScriptRoot
if (-not (Test-Path node_modules)) { npm install }
if (-not (Test-Path bin\whisper)) { npm run setup }
if (-not (Test-Path .next\BUILD_ID)) { npm run build }
Start-Process "http://127.0.0.1:5000"
npm start
