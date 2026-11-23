# Build the bundled Tailscale client (tailscaled + tailscale CLI) from source (Windows / PowerShell 5+).
#
#   pwsh desktop/scripts/build-tailscale.ps1                     # host: win32 x64
#   pwsh desktop/scripts/build-tailscale.ps1 -Platform win32 -Arch arm64
#
# Mirrors build-tailscale.sh: output desktop/resources/tailscale/<platform>-<arch>/
# (Node/Electron names), manifest.json with sha256 per file, and
# desktop/resources/licenses/tailscale-LICENSE. Versions pinned by
# scripts/tailscale-mod/go.mod + go.sum. Needs Go >= 1.24 on PATH; GOTOOLCHAIN=auto
# downloads the toolchain go.mod asks for.
[CmdletBinding()]
param(
  [string]$Platform = "win32",
  [string]$Arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" })
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$TsVersion = "v1.104.7"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Desktop = Split-Path -Parent $Here
$Mod = Join-Path $Here "tailscale-mod"

switch ($Platform.ToLower()) {
  { $_ -in "win32", "windows", "win" } { $Platform = "win32"; $GoOs = "windows" }
  { $_ -in "darwin", "macos", "mac" }  { $Platform = "darwin"; $GoOs = "darwin" }
  "linux"                              { $GoOs = "linux" }
  default { throw "unsupported platform: $Platform" }
}
switch ($Arch.ToLower()) {
  { $_ -in "x64", "amd64" }   { $Arch = "x64"; $GoArch = "amd64" }
  { $_ -in "arm64", "aarch64" } { $Arch = "arm64"; $GoArch = "arm64" }
  default { throw "unsupported arch: $Arch" }
}
$Exe = if ($GoOs -eq "windows") { ".exe" } else { "" }

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  throw "go not found on PATH (need Go >= 1.24; GOTOOLCHAIN=auto fetches the rest)"
}

$Out = Join-Path $Desktop "resources\tailscale\$Platform-$Arch"
$LicDir = Join-Path $Desktop "resources\licenses"
New-Item -ItemType Directory -Force -Path $Out, $LicDir | Out-Null

$V = $TsVersion.TrimStart("v")
$saved = @{}
foreach ($k in "GOTOOLCHAIN", "CGO_ENABLED", "GOOS", "GOARCH", "GOFLAGS") { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
try {
  $env:GOTOOLCHAIN = "auto"; $env:CGO_ENABLED = "0"; $env:GOOS = $GoOs; $env:GOARCH = $GoArch; $env:GOFLAGS = "-mod=readonly"
  Push-Location $Mod
  try {
    Write-Host "building tailscale $TsVersion for $GoOs/$GoArch -> $Out"
    $ld = "-s -w -X tailscale.com/version.longStamp=$V-airbridge -X tailscale.com/version.shortStamp=$V"
    & go build -trimpath -ldflags $ld -o ($Out + [IO.Path]::DirectorySeparatorChar) tailscale.com/cmd/tailscaled tailscale.com/cmd/tailscale
    if ($LASTEXITCODE -ne 0) { throw "go build failed ($LASTEXITCODE)" }
    $GoVer = (& go env GOVERSION).Trim()
    $ModDir = (& go list -m -f "{{.Dir}}" tailscale.com).Trim()
  } finally { Pop-Location }
} finally {
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
}

Copy-Item -Force (Join-Path $ModDir "LICENSE") (Join-Path $LicDir "tailscale-LICENSE")

$Tsd = "tailscaled$Exe"; $Tsc = "tailscale$Exe"
$manifest = [ordered]@{
  name    = "tailscale"
  version = $TsVersion
  go      = $GoVer
  goos    = $GoOs
  goarch  = $GoArch
  license = "BSD-3-Clause (see licenses/tailscale-LICENSE)"
  files   = [ordered]@{
    $Tsd = (Get-FileHash -Algorithm SHA256 (Join-Path $Out $Tsd)).Hash.ToLower()
    $Tsc = (Get-FileHash -Algorithm SHA256 (Join-Path $Out $Tsc)).Hash.ToLower()
  }
}
$json = $manifest | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $Out "manifest.json"), $json + "`n", (New-Object Text.UTF8Encoding($false)))
Write-Host "ok: $((Get-ChildItem $Out).Name -join ' ')"
