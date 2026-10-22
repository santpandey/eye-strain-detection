# blinkwell installer for Windows - https://<site>/install.ps1
#   irm https://<site>/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # suppress Invoke-WebRequest's own byte UI (fallback path)

$Repo = if ($env:BLINKWELL_REPO) { $env:BLINKWELL_REPO } else { 'santpandey/eye-strain-detection' }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$asset = "blinkwell-windows-$arch.zip"
$url = "https://github.com/$Repo/releases/latest/download/$asset"

$dest = Join-Path $env:LOCALAPPDATA 'blinkwell'
New-Item -ItemType Directory -Force $dest | Out-Null

# Streamed download with a single-line progress bar, ASCII-only (PowerShell
# 5.1 mangles UTF-8 box chars). Falls back to a quiet Invoke-WebRequest on
# runtimes too old for HttpClient.
function Get-WithProgress($url, $outFile) {
  Add-Type -AssemblyName System.Net.Http -ErrorAction Stop  # needed on PS 5.1; no-op on PS7
  $client = New-Object System.Net.Http.HttpClient
  try {
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('blinkwell-installer')
    $resp = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
    $resp.EnsureSuccessStatusCode() | Out-Null
    $total = if ($resp.Content.Headers.ContentLength) { [double]$resp.Content.Headers.ContentLength } else { 0 }
    $src = $resp.Content.ReadAsStreamAsync().Result
    $dst = [System.IO.File]::Create($outFile)
    try {
      $buf = New-Object byte[] 65536
      $got = [double]0
      $shown = -1
      while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) {
        $dst.Write($buf, 0, $n)
        $got += $n
        if ($total -gt 0) {
          $pct = [math]::Floor(100.0 * $got / $total)
          if ($pct -ne $shown) {
            $shown = $pct
            $w = [math]::Floor($pct / 5)
            Write-Host ("`r  [{0}{1}] {2,3}%" -f ('#' * $w), (' ' * (20 - $w)), $pct) -NoNewline
          }
        }
      }
      Write-Host ''
    } finally {
      $dst.Dispose()
      $src.Dispose()
      $resp.Dispose()
    }
  } finally {
    $client.Dispose()
  }
}

$tmp = Join-Path $env:TEMP "blinkwell-$([guid]::NewGuid()).zip"
try {
  Write-Host "blinkwell: downloading $asset"
  try {
    Get-WithProgress $url $tmp
  } catch {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  }
  Write-Host 'blinkwell: installing'
  Expand-Archive -Path $tmp -DestinationPath $dest -Force
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dest*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  $env:Path = "$env:Path;$dest"
}

# First run downloads libmediapipe (~12 MB, checksummed PyPI wheel) once.
Write-Host "blinkwell: installed - open a NEW terminal window, then type: blinkwell"
