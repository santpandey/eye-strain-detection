#!/bin/sh
# eyefd installer — https://<site>/install.sh
#   curl -fsSL https://<site>/install.sh | sh
# Downloads the latest release binary for your OS/arch and puts it on PATH.
set -eu

REPO="${EYEFD_REPO:-santpandey/eye-strain-detection}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  linux)  os=linux ;;
  darwin) os=macos ;;
  *) echo "eyefd: unsupported OS '$os' (use install.ps1 on Windows)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "eyefd: unsupported arch '$arch'" >&2; exit 1 ;;
esac
[ "$os-$arch" = "macos-x64" ] && { echo "eyefd: Intel Macs — use 'pipx install eyefd' instead." >&2; exit 1; }
[ "$os-$arch" = "linux-arm64" ] && { echo "eyefd: Linux ARM — use 'pipx install eyefd' instead." >&2; exit 1; }

asset="eyefd-${os}-${arch}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "eyefd: downloading ${asset}"
curl -fsSL "$url" -o "$tmp/$asset"
tar -xzf "$tmp/$asset" -C "$tmp"

bin_dir="$HOME/.local/bin"
mkdir -p "$bin_dir"
install -m 0755 "$tmp/eyefd" "$bin_dir/eyefd"
echo "eyefd: installed to $bin_dir/eyefd"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "eyefd: add '$bin_dir' to your PATH (e.g. in ~/.profile or ~/.zshrc)" ;;
esac

# First run downloads libmediapipe (~12 MB, checksummed PyPI wheel) once.
echo "eyefd: done. Try: eyefd check    or    eyefd monitor"
