# Khmer AI Dubber: installs whatever is missing, then starts the app at http://127.0.0.1:5000
# Use start.cmd (it runs this script even where PowerShell scripts are blocked).
Set-Location $PSScriptRoot

function Stop-WithMessage($msg) {
  Write-Host "`n$msg" -ForegroundColor Red
  exit 1
}

function Update-PathFromSystem {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

# Already running (e.g. start.cmd double-clicked twice)? Just show it.
try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5000/api/capabilities -TimeoutSec 2 | Out-Null
  Write-Host "Khmer AI Dubber is already running: http://127.0.0.1:5000"
  Start-Process "http://127.0.0.1:5000"
  exit 0
} catch { }

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Stop-WithMessage "Node.js is needed. Install the LTS version from https://nodejs.org, then run start.cmd again."
  }
  Write-Host "Installing Node.js LTS (a Windows prompt may appear)..."
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  Update-PathFromSystem
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Stop-WithMessage "Node.js was installed. Close this window and run start.cmd again."
  }
}

# 2. Setup: the first time, and again when the installer or the packages changed (e.g. after git pull).
#    npm run setup writes .setup-done.json with the same fingerprint when it finishes.
$marker = ".setup-done.json"
#    (line endings are ignored: git may check the same file out with CRLF or LF)
$sha = [Security.Cryptography.SHA256]::Create()
$fingerprint = (@("scripts\setup.mjs", "package-lock.json") | ForEach-Object {
  $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $_), [Text.Encoding]::UTF8).Replace("`r", "")
  -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString("X2") })
}) -join ""
$done = $null
if (Test-Path $marker) { $done = Get-Content $marker -Raw | ConvertFrom-Json }
if (-not $done -or $done.fingerprint -ne $fingerprint) {
  $setupArgs = @()
  if ($done -and $done.args) { $setupArgs = @($done.args) }  # keep earlier choices such as --no-clone
  Write-Host "Setting up (the first time this downloads ~9 GB and takes 15-30 minutes)...`n"
  npm run setup -- @setupArgs
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Setup did not finish - see the message above, then run start.cmd again." }
}

# 3. Build when the code changed since the last build
$build = ".next\BUILD_ID"
$newest = Get-ChildItem app, lib, next.config.ts, package.json, tsconfig.json -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path $build) -or $newest.LastWriteTime -gt (Get-Item $build).LastWriteTime) {
  npm run build
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Build failed - see the message above." }
}

# 4. Start (the browser opens once the server answers)
Start-Job -ScriptBlock {
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5000/api/capabilities -TimeoutSec 2 | Out-Null; break }
    catch { Start-Sleep -Seconds 1 }
  }
  Start-Process "http://127.0.0.1:5000"
} | Out-Null
Write-Host "`nKhmer AI Dubber: http://127.0.0.1:5000   (close this window to stop it)`n"
npm start
