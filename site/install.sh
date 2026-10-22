#!/bin/sh
# blinkwell installer — https://<site>/install.sh
#   curl -fsSL https://<site>/install.sh | sh
# Downloads the latest release binary for your OS/arch and puts it on PATH.
# Works in any POSIX-ish shell: macOS/Linux terminals AND Windows Git Bash /
# MSYS2 / Cygwin (which install the native Windows build).
set -eu

REPO="${BLINKWELL_REPO:-santpandey/eye-strain-detection}"

uname_s="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$uname_s" in
  linux*)                  os=linux ;;
  darwin*)                 os=macos ;;
  mingw*|msys*|cygwin*)    os=windows ;;  # Git Bash & friends run the .exe natively
  *) echo "blinkwell: unsupported OS '$uname_s' (use install.ps1 in PowerShell)" >&2; exit 1 ;;
esac
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)    arch=x64 ;;
  arm64|aarch64)   arch=arm64 ;;
  i?86)            arch=x32 ;;  # 32-bit shell — decided by OS arch below
  *) echo "blinkwell: unsupported arch '$arch'" >&2; exit 1 ;;
esac
if [ "$os" = windows ]; then
  # A 32-bit Git Bash/MSYS2 on a 64-bit Windows reports i686 — the Windows
  # env vars describe the OS, which is what the binary must match.
  case "${PROCESSOR_ARCHITEW6432:-$PROCESSOR_ARCHITECTURE}" in
    ARM64) arch=arm64 ;;
    *)     arch=x64 ;;
  esac
elif [ "$arch" = x32 ]; then
  echo "blinkwell: 32-bit systems aren't supported — use 'pipx install blinkwell'" >&2; exit 1
fi
[ "$os-$arch" = "macos-x64" ]  && { echo "blinkwell: Intel Macs — use 'pipx install blinkwell' instead." >&2; exit 1; }
[ "$os-$arch" = "linux-arm64" ] && { echo "blinkwell: Linux ARM — use 'pipx install blinkwell' instead." >&2; exit 1; }

if [ "$os" = windows ]; then asset="blinkwell-windows-${arch}.zip"
else asset="blinkwell-${os}-${arch}.tar.gz"; fi
url="https://github.com/${REPO}/releases/latest/download/${asset}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# curl ships everywhere (incl. Windows 10+); wget is the fallback on
# minimal distros/containers.
dl() {
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress "$1" -O "$2" || wget -q "$1" -O "$2"
  else
    echo "blinkwell: need curl or wget to download" >&2; exit 1
  fi
}

echo "blinkwell: downloading ${asset}"
dl "$url" "$tmp/$asset"

if [ "$os" = windows ]; then
  # Git Bash's tar is GNU tar, which can't read .zip. unzip comes with Git
  # for Windows; PowerShell Expand-Archive is the guaranteed fallback.
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$tmp/$asset" -d "$tmp"
  else
    w() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || echo "$1"; }
    powershell -NoProfile -Command \
      "Expand-Archive -LiteralPath '$(w "$tmp/$asset")' -DestinationPath '$(w "$tmp")' -Force"
  fi

  # Normalize Windows backslashes — POSIX coreutils prefer forward slashes.
  bin_dir="${LOCALAPPDATA:-$HOME/AppData/Local}/blinkwell"
  bin_dir="$(echo "$bin_dir" | tr '\\\\' '/')"
  mkdir -p "$bin_dir"
  install -m 0755 "$tmp/blinkwell.exe" "$bin_dir/blinkwell.exe"
  echo "blinkwell: installed to $bin_dir/blinkwell.exe"

  # Register on the real Windows user PATH (PowerShell owns that store).
  win_dir="$(command -v cygpath >/dev/null 2>&1 && cygpath -w "$bin_dir" || echo "$bin_dir")"
  powershell -NoProfile -Command \
    "\$p=[Environment]::GetEnvironmentVariable('Path','User'); \
     if (\$p -notlike \"*$win_dir*\") { \
       [Environment]::SetEnvironmentVariable('Path', \"\$p;$win_dir\", 'User') }" \
    2>/dev/null || echo "blinkwell: add '$bin_dir' to your PATH"
  echo "blinkwell: done - open a NEW terminal window, then type: blinkwell"
else
  tar -xzf "$tmp/$asset" -C "$tmp"

  bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  install -m 0755 "$tmp/blinkwell" "$bin_dir/blinkwell"
  echo "blinkwell: installed to $bin_dir/blinkwell"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "blinkwell: add '$bin_dir' to your PATH (e.g. in ~/.profile or ~/.zshrc)" ;;
  esac

  # First run downloads libmediapipe (~12 MB, checksummed PyPI wheel) once.
  echo "blinkwell: done. Try: blinkwell check    or    blinkwell monitor"
fi
