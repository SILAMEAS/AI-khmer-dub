# Khmer AI Dubber: installs whatever is missing, then starts the app at http://127.0.0.1:5000
# Use start.cmd (it runs this script even where PowerShell scripts are blocked).
# (-LiteralPath everywhere: a folder name with [ ] in it would otherwise be read as a wildcard)
Set-Location -LiteralPath $PSScriptRoot

# (defined first: a script can only call a function defined above the call)
function Stop-WithMessage($msg) {
  Write-Host "`n$msg" -ForegroundColor Red
  exit 1
}

# Options typed after start.cmd (e.g. start.cmd --no-separation) are passed on to setup
$extraArgs = @($args)
# older Windows 10 / .NET may not offer TLS 1.2 by default, which nodejs.org requires
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# The programs it downloads are made for x64 PCs. Windows 11 on ARM runs them (emulated); Windows 10 on ARM can't.
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -eq "x86") { Stop-WithMessage "This is a 32-bit Windows - the app needs 64-bit Windows 10 or 11." }
if ($arch -eq "ARM64" -and [Environment]::OSVersion.Version.Build -lt 22000) {
  Stop-WithMessage "This PC has an ARM processor with Windows 10, which cannot run the app's programs (they are made for x64 PCs). Windows 11 on ARM can: update to Windows 11, or use another PC."
}

# Behind a company or school proxy nothing gets out directly. Windows knows the proxy (also one set by an
# automatic "PAC" script); npm, pip, yt-dlp, setup and the app take it from HTTPS_PROXY. One set already is kept.
if (-not $env:HTTPS_PROXY) {
  try {
    $probe = [Uri]"https://registry.npmjs.org/"
    $p = [Net.WebRequest]::GetSystemWebProxy().GetProxy($probe)
    if ($p -and $p.Authority -ne $probe.Authority) {
      $env:HTTPS_PROXY = "http://$($p.Authority)"; $env:HTTP_PROXY = $env:HTTPS_PROXY
      Write-Host "Using this PC's proxy: $($p.Authority)"
    }
  } catch { }
}
if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
  $env:NO_PROXY = (@("127.0.0.1", "localhost", $env:NO_PROXY) | Where-Object { $_ }) -join ","  # the app itself: never through it
  $env:NODE_USE_ENV_PROXY = "1"  # Node.js 22.21+ / 24: its fetch() follows HTTPS_PROXY by itself
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
if (-not $pcNodeOk -and (Test-Path -LiteralPath (Join-Path $ownNode "node.exe"))) { $env:Path = "$ownNode;$env:Path" }

# Already running (e.g. start.cmd double-clicked twice)? Just show it.
try {
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5000/api/capabilities -TimeoutSec 2 | Out-Null
  Write-Host "Khmer AI Dubber is already running: http://127.0.0.1:5000"
  Start-Process "http://127.0.0.1:5000"
  exit 0
} catch { }

# A program from the app's own bin\ or py\ folder (yt-dlp, aria2c, ffmpeg, whisper, the Python voice worker)
# whose parent has ended is left from a session whose window was closed while it worked: Windows does not stop
# what a closed program started. It would keep downloading and keep its files locked - stop it, with what it
# started. Only orphans: a program the running app (or another setup window) started still has its parent.
$own = @("$PSScriptRoot\bin\", "$PSScriptRoot\py\")
$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in $procs) { [void]$pids.Add([int]$p.ProcessId) }
$procs | Where-Object {
  $exe = $_.ExecutablePath
  $exe -and @($own | Where-Object { $exe.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -and
    -not $exe.StartsWith("$PSScriptRoot\bin\node\", [StringComparison]::OrdinalIgnoreCase) -and  # not Node.js itself
    -not $pids.Contains([int]$_.ParentProcessId)  # its parent is gone
} | ForEach-Object {
  Write-Host "Stopping $($_.Name) left running by the last session"
  & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null  # /T: and what it started (yt-dlp's aria2c, ffmpeg)
}

# The PC's own Node.js is new enough (e.g. updated since): the portable copy is a duplicate
if ($pcNodeOk -and (Test-Path -LiteralPath $ownNode)) {
  Write-Host "Removing the portable Node.js in bin\node - the one on this PC is new enough."
  Remove-Item -LiteralPath $ownNode -Recurse -Force -ErrorAction SilentlyContinue
}

# 1. Node.js: the one on the PC if it is new enough, or else a portable one downloaded into bin\node
#    (nothing installed on C:)
if (-not (Test-NodeOk)) {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "The Node.js on this PC ($(& node -v)) is too old - using a portable one instead (your own stays as it is)."
  }
  Remove-Item -LiteralPath $ownNode -Recurse -Force -ErrorAction SilentlyContinue  # an old or broken portable one
  Write-Host "Downloading Node.js LTS into bin\node..."
  try {
    $ProgressPreference = "SilentlyContinue" # Windows PowerShell's progress bar makes downloads very slow
    # (the parentheses matter: Windows PowerShell passes a downloaded JSON list on as one item otherwise)
    $lts = ((Invoke-RestMethod https://nodejs.org/dist/index.json) | Where-Object { $_.lts } | Select-Object -First 1).version
    $zip = Join-Path $tmp "node.zip"
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$lts/node-$lts-win-x64.zip" -OutFile $zip
    $unpacked = Join-Path $tmp "node-unpacked"
    Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction SilentlyContinue  # left from an interrupted try
    New-Item -ItemType Directory -Force $unpacked | Out-Null
    $tar = "$env:SystemRoot\System32\tar.exe"
    if (Test-Path -LiteralPath $tar) { & $tar -xf $zip -C $unpacked }  # fast
    else { Expand-Archive -LiteralPath $zip -DestinationPath $unpacked -Force }  # Windows 10 before 1803 has no tar
    New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot "bin") | Out-Null
    Move-Item -LiteralPath (Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1).FullName -Destination $ownNode
    Remove-Item -LiteralPath $unpacked, $zip -Recurse -Force
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
if (Test-Path -LiteralPath $marker) { try { $done = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json } catch { } }
if (-not $done -or $done.fingerprint -ne $fingerprint -or $extraArgs.Count) {
  $setupArgs = @()
  if ($done -and $done.args) { $setupArgs = @($done.args) }  # keep earlier choices such as --no-separation
  $setupArgs = @($setupArgs + $extraArgs | Select-Object -Unique)
  Write-Host "Setting up (the first time this downloads ~5 GB and takes 10-20 minutes)...`n"
  npm run setup -- @setupArgs
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Setup did not finish - see the message above, then run start.cmd again." }
}

# 3. Build when the code changed since the last build
$build = ".next\BUILD_ID"
$newest = Get-ChildItem -LiteralPath app, lib, proxy.ts, instrumentation.ts, next.config.ts, package.json, tsconfig.json -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not (Test-Path -LiteralPath $build) -or $newest.LastWriteTime -gt (Get-Item -LiteralPath $build).LastWriteTime) {
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
