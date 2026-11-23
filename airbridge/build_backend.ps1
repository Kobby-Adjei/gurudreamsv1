# Build the airbridge-core backend binary on Windows.
#
#   powershell -ExecutionPolicy Bypass -File airbridge\build_backend.ps1
#   $env:PYTHON = "py -3.12"; .\airbridge\build_backend.ps1
#
# Output: desktop\resources\bin\win32-<arch>\airbridge-core.exe
# PyInstaller cannot cross-compile: run this on each target arch (CI matrix).
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$Python = if ($env:PYTHON) { $env:PYTHON } else { 'py -3' }
$Venv = if ($env:AIRBRIDGE_BUILD_VENV) { $env:AIRBRIDGE_BUILD_VENV } else { Join-Path $ScriptDir '.build-venv' }
$Work = if ($env:AIRBRIDGE_BUILD_WORK) { $env:AIRBRIDGE_BUILD_WORK } else { Join-Path $ScriptDir 'build\pyinstaller' }

switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { $Arch = 'x64' }
  'ARM64' { $Arch = 'arm64' }
  default { throw "unsupported architecture $($env:PROCESSOR_ARCHITECTURE)" }
}
$OutDir = Join-Path $RepoRoot "desktop\resources\bin\win32-$Arch"
$Bin = Join-Path $OutDir 'airbridge-core.exe'

function Invoke-Checked([string]$Exe, [string[]]$ArgList) {
  & $Exe @ArgList
  if ($LASTEXITCODE -ne 0) { throw "$Exe $($ArgList -join ' ') failed with exit code $LASTEXITCODE" }
}

Write-Host "==> build venv: $Venv"
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
  $parts = $Python -split ' '
  $pyArgs = @()
  if ($parts.Length -gt 1) { $pyArgs = $parts[1..($parts.Length - 1)] }
  Invoke-Checked $parts[0] ($pyArgs + @('-m', 'venv', $Venv))
}
Invoke-Checked $VenvPython @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip')
Invoke-Checked $VenvPython @('-m', 'pip', 'install', '--quiet',
  '-r', (Join-Path $ScriptDir 'requirements.txt'),
  '-r', (Join-Path $ScriptDir 'requirements-build.txt'))

Write-Host "==> pyinstaller -> $OutDir"
New-Item -ItemType Directory -Force -Path $OutDir, $Work | Out-Null
Push-Location $ScriptDir
try {
  Invoke-Checked $VenvPython @('-m', 'PyInstaller', '--noconfirm', '--clean',
    '--distpath', $OutDir, '--workpath', $Work,
    (Join-Path $ScriptDir 'airbridge-core.spec'))
} finally {
  Pop-Location
}
if (-not (Test-Path $Bin)) { throw "binary not produced at $Bin" }

Write-Host '==> smoke test'
$SmokeTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("airbridge-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $SmokeTmp | Out-Null
$env:AIRBRIDGE_LOG_FILE = Join-Path $SmokeTmp 'airbridge.log'
$env:AIRBRIDGE_DATA_DIR = Join-Path $SmokeTmp 'data'
try {
  $help = & $Bin --help 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "--help exited $LASTEXITCODE" }
  if ($help -notmatch '--daemon') { throw '--help output missing --daemon' }
  Write-Host '    --help ok'

  $p = Start-Process -FilePath $Bin -ArgumentList '--check' -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $SmokeTmp 'check.out') -RedirectStandardError (Join-Path $SmokeTmp 'check.err')
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 2) {
    Get-Content (Join-Path $SmokeTmp 'check.err') | Write-Host
    throw "--check exited $($p.ExitCode) (expected 0, or 2 when Tailscale is absent)"
  }
  if ((Get-Item (Join-Path $SmokeTmp 'check.out')).Length -gt 0) { throw '--check wrote to stdout' }
  Write-Host "    --check exit $($p.ExitCode) ok"

  $saved = $env:AIRBRIDGE_CONTROL_TOKEN
  Remove-Item Env:\AIRBRIDGE_CONTROL_TOKEN -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $Bin -ArgumentList '--daemon' -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $SmokeTmp 'daemon.out') -RedirectStandardError (Join-Path $SmokeTmp 'daemon.err')
  if ($saved) { $env:AIRBRIDGE_CONTROL_TOKEN = $saved }
  if ($p.ExitCode -ne 2) { throw "--daemon without token exited $($p.ExitCode) (expected 2)" }
  Write-Host '    --daemon without token exit 2 ok'
} finally {
  Remove-Item -Recurse -Force $SmokeTmp -ErrorAction SilentlyContinue
}

Get-Item $Bin | Format-List Name, Length, LastWriteTime
Write-Host "==> done: $Bin"
