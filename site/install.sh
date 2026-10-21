#!/bin/sh
# blinkwell installer — https://<site>/install.sh
#   curl -fsSL https://<site>/install.sh | sh
# Downloads the latest release binary for your OS/arch and puts it on PATH.
set -eu

REPO="${BLINKWELL_REPO:-santpandey/eye-strain-detection}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  linux)  os=linux ;;
  darwin) os=macos ;;
  *) echo "blinkwell: unsupported OS '$os' (use install.ps1 on Windows)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "blinkwell: unsupported arch '$arch'" >&2; exit 1 ;;
esac
[ "$os-$arch" = "macos-x64" ] && { echo "blinkwell: Intel Macs — use 'pipx install blinkwell' instead." >&2; exit 1; }
[ "$os-$arch" = "linux-arm64" ] && { echo "blinkwell: Linux ARM — use 'pipx install blinkwell' instead." >&2; exit 1; }

asset="blinkwell-${os}-${arch}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "blinkwell: downloading ${asset}"
curl -fsSL "$url" -o "$tmp/$asset"
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
