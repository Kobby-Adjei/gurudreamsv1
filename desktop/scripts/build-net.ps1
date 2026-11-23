# Build the airbridge-net private-network sidecar on Windows (see build-net.sh for details).
#
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\build-net.ps1                 # host (windows/amd64)
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\build-net.ps1 all
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\build-net.ps1 windows/amd64 darwin/arm64
#
# Output: desktop\resources\net\<platform>-<arch>\airbridge-net[.exe] + manifest.json (sha256).
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Targets)
$ErrorActionPreference = 'Stop'

$Desktop = Resolve-Path (Join-Path $PSScriptRoot '..')
$Src = Join-Path $Desktop 'sidecar\airbridge-net'
$OutBase = Join-Path $Desktop 'resources\net'
$Licenses = Join-Path $Desktop 'resources\licenses'
$TsVersion = 'v1.104.7'

if (-not $env:GOTOOLCHAIN) { $env:GOTOOLCHAIN = 'auto' }
$env:CGO_ENABLED = '0'
if (-not $env:GOFLAGS) { $env:GOFLAGS = '-mod=readonly' }

if (-not $Targets -or $Targets.Count -eq 0) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  $Targets = @("windows/$arch")
}
if ($Targets[0] -eq 'all') { $Targets = @('darwin/arm64', 'darwin/amd64', 'windows/amd64', 'linux/amd64') }

Push-Location $Src
try {
  $goVersion = (& go env GOVERSION).Trim()
  foreach ($t in $Targets) {
    $goos, $goarch = $t.Split('/')
    if (@('darwin/arm64', 'darwin/amd64', 'windows/amd64', 'linux/amd64', 'linux/arm64') -notcontains $t) {
      throw "build-net.ps1: unsupported target $t"
    }
    $plat = if ($goos -eq 'windows') { 'win32' } else { $goos }
    $archName = if ($goarch -eq 'amd64') { 'x64' } else { $goarch }
    $exe = if ($goos -eq 'windows') { 'airbridge-net.exe' } else { 'airbridge-net' }
    $out = Join-Path $OutBase "$plat-$archName"
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    Write-Host "==> airbridge-net $goos/$goarch -> $out\$exe"
    $env:GOOS = $goos; $env:GOARCH = $goarch
    & go build -trimpath -ldflags '-s -w' -o (Join-Path $out $exe) .
    if ($LASTEXITCODE -ne 0) { throw "go build failed for $t" }
    $file = Get-Item (Join-Path $out $exe)
    $sum = (Get-FileHash -Algorithm SHA256 $file.FullName).Hash.ToLower()
    $manifest = [ordered]@{
      name = 'airbridge-net'; tailscale_version = $TsVersion; go_version = $goVersion; goos = $goos; goarch = $goarch
      files = @{ $exe = [ordered]@{ sha256 = $sum; size = $file.Length } }
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $out 'manifest.json')
    Write-Host "    sha256 $sum ($($file.Length) bytes)"
  }
  Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
  $modDir = (& go list -m -f '{{.Dir}}' tailscale.com).Trim()
  New-Item -ItemType Directory -Force -Path $Licenses | Out-Null
  Copy-Item -Force (Join-Path $modDir 'LICENSE') (Join-Path $Licenses 'tailscale-LICENSE')
  Write-Host '==> done'
} finally {
  Pop-Location
}
