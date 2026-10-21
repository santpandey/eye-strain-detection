# blinkwell installer for Windows — https://<site>/install.ps1
#   irm https://<site>/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo = if ($env:BLINKWELL_REPO) { $env:BLINKWELL_REPO } else { 'santpandey/eye-strain-detection' }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$asset = "blinkwell-windows-$arch.zip"
$url = "https://github.com/$Repo/releases/latest/download/$asset"

$dest = Join-Path $env:LOCALAPPDATA 'blinkwell'
New-Item -ItemType Directory -Force $dest | Out-Null

$tmp = Join-Path $env:TEMP "blinkwell-$([guid]::NewGuid()).zip"
try {
  Write-Host "blinkwell: downloading $asset"
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  Expand-Archive -Path $tmp -DestinationPath $dest -Force
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dest*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  $env:Path = "$env:Path;$dest"
  Write-Host "blinkwell: added $dest to your PATH (new terminals will see it)"
}

# First run downloads libmediapipe (~12 MB, checksummed PyPI wheel) once.
Write-Host "blinkwell: installed to $dest\blinkwell.exe — try: blinkwell check   or   blinkwell monitor"
