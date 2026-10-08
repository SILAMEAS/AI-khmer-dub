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

# Everything this app writes stays inside its folder, not on the system drive: npm's download cache,
# temporary files (npm, the build, the app), and a portable Node.js when the PC has none.
$env:npm_config_cache = Join-Path $PSScriptRoot ".cache\npm"
$tmp = Join-Path $PSScriptRoot "tmp"
New-Item -ItemType Directory -Force $tmp | Out-Null
$env:TEMP = $tmp; $env:TMP = $tmp
$ownNode = Join-Path $PSScriptRoot "bin\node"
# Node.js 20.9+ is what Next.js needs
function Test-NodeOk {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  try { $v = [version]((& node -v) -replace "^v", "") } catch { return $false }
  return $v -ge [version]"20.9"
}
$pcNodeOk = Test-NodeOk  # the PC's own Node.js, checked before the portable one is put first
if (-not $pcNodeOk -and (Test-Path (Join-Path $ownNode "node.exe"))) { $env:Path = "$ownNode;$env:Path" }

# Already running (e.g. start.cmd double-clicked twice)? Just show it.
try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5000/api/capabilities -TimeoutSec 2 | Out-Null
  Write-Host "Khmer AI Dubber is already running: http://127.0.0.1:5000"
  Start-Process "http://127.0.0.1:5000"
  exit 0
} catch { }

# The PC's own Node.js is new enough (e.g. updated since): the portable copy is a duplicate
if ($pcNodeOk -and (Test-Path $ownNode)) {
  Write-Host "Removing the portable Node.js in bin\node - the one on this PC is new enough."
  Remove-Item -Recurse -Force $ownNode -ErrorAction SilentlyContinue
}

# 1. Node.js: the one on the PC if it is new enough, or else a portable one downloaded into bin\node
#    (nothing installed on C:)
if (-not (Test-NodeOk)) {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "The Node.js on this PC ($(& node -v)) is too old - using a portable one instead (your own stays as it is)."
  }
  Remove-Item -Recurse -Force $ownNode -ErrorAction SilentlyContinue  # an old or broken portable one
  Write-Host "Downloading Node.js LTS into bin\node..."
  try {
    $ProgressPreference = "SilentlyContinue" # Windows PowerShell's progress bar makes downloads very slow
    # (the parentheses matter: Windows PowerShell passes a downloaded JSON list on as one item otherwise)
    $lts = ((Invoke-RestMethod https://nodejs.org/dist/index.json) | Where-Object { $_.lts } | Select-Object -First 1).version
    $zip = Join-Path $tmp "node.zip"
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$lts/node-$lts-win-x64.zip" -OutFile $zip
    $unpacked = Join-Path $tmp "node-unpacked"
    Remove-Item -Recurse -Force $unpacked -ErrorAction SilentlyContinue  # left from an interrupted try
    & "$env:SystemRoot\System32\tar.exe" -xf $zip -C (New-Item -ItemType Directory -Force $unpacked).FullName
    New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot "bin") | Out-Null
    Move-Item (Get-ChildItem $unpacked -Directory | Select-Object -First 1).FullName $ownNode
    Remove-Item -Recurse -Force $unpacked, $zip
    $env:Path = "$ownNode;$env:Path"
  } catch { }
  if (-not (Test-NodeOk)) {
    Stop-WithMessage "Node.js could not be downloaded. Check the internet connection, or install it from https://nodejs.org, then run start.cmd again."
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
