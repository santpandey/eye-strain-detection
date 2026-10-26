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
  echo "blinkwell: 32-bit systems aren't supported — mediapipe ships no 32-bit wheels, so the pip package won't install either." >&2; exit 1
fi
[ "$os-$arch" = "macos-x64" ]  && { echo "blinkwell: Intel Macs — use 'pipx install blinkwell' instead." >&2; exit 1; }
[ "$os-$arch" = "linux-arm64" ] && { echo "blinkwell: no native ARM-Linux build (mediapipe ships no aarch64 C-API lib) — but 'pipx install blinkwell' works: the Python pipeline uses mediapipe's aarch64 wheel." >&2; exit 1; }

if [ "$os" = windows ]; then asset="blinkwell-windows-${arch}.zip"
else asset="blinkwell-${os}-${arch}.tar.gz"; fi
url="https://github.com/${REPO}/releases/latest/download/${asset}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# curl ships everywhere (incl. Windows 10+); wget is the fallback on
# minimal distros/containers.
dl() {
  if command -v curl >/dev/null 2>&1; then
    # --retry rides out transient TLS/connection flakes (schannel 56 etc.).
    curl -fL --progress-bar --retry 3 "$1" -o "$2"
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

  case ":$PATH:" in *":$bin_dir:"*) on_path=1 ;; *) on_path=0 ;; esac

  if [ "$on_path" -eq 0 ]; then
    # ── future terminals: a terminal app (iTerm, Terminal, WezTerm, VS Code,
    # tmux…) just launches the user's shell, so coverage means that shell's
    # startup files — and which file depends on HOW it's launched:
    #   zsh    .zprofile (login) + .zshrc (interactive, incl. non-login)
    #   bash   login reads ONLY the first of .bash_profile → .bash_login →
    #          .profile that exists (don't create .bash_profile over an
    #          existing .profile — it would shadow it); + .bashrc (non-login)
    #   sh/dash/ksh, ssh sessions: .profile (POSIX login fallback)
    #   fish   fish_user_paths universal var — written via fish_add_path,
    #          survives later config.fish edits (no rc line needed)
    #   pwsh   Microsoft.PowerShell_profile.ps1 (every interactive host)
    #   nu     env.nu (every session);  csh/tcsh: .tcshrc/.cshrc
    # Only the login shell's files are created; other shells are covered only
    # if installed/configured. The guarded grep makes re-installs no-op.
    line='export PATH="$HOME/.local/bin:$PATH"'
    add_line() {  # $1 = rc file, $2 = snippet — skipped if dir already listed
      if [ -f "$1" ] && grep -q '/\.local/bin' "$1" 2>/dev/null; then return; fi
      printf '\n# blinkwell\n%s\n' "$2" >>"$1" 2>/dev/null \
        && echo "blinkwell: PATH for new terminals saved to ~${1#$HOME}"
    }
    case "$(basename "${SHELL:-}")" in
      zsh)
        add_line "$HOME/.zprofile" "$line"; add_line "$HOME/.zshrc" "$line" ;;
      bash)
        if   [ -f "$HOME/.bash_profile" ]; then add_line "$HOME/.bash_profile" "$line"
        elif [ -f "$HOME/.bash_login" ];  then add_line "$HOME/.bash_login" "$line"
        elif [ -f "$HOME/.profile" ];     then add_line "$HOME/.profile" "$line"
        else                                  add_line "$HOME/.bash_profile" "$line"; fi
        add_line "$HOME/.bashrc" "$line" ;;
      *)
        add_line "$HOME/.profile" "$line" ;;
    esac
    # .profile is the universal login fallback — inert under zsh, covers
    # sh/ksh/dash and any later-installed login shell.
    add_line "$HOME/.profile" "$line"
    # Other installed shells, in their own idioms.
    command -v fish >/dev/null 2>&1 \
      && fish -c 'fish_add_path -U "$HOME/.local/bin"' >/dev/null 2>&1 \
      && echo "blinkwell: PATH added for fish (fish_user_paths)"
    if command -v pwsh >/dev/null 2>&1; then
      mkdir -p "$HOME/.config/powershell"
      add_line "$HOME/.config/powershell/Microsoft.PowerShell_profile.ps1" \
        '$env:PATH = "$HOME/.local/bin" + [IO.Path]::PathSeparator + $env:PATH'
    fi
    [ -f "$HOME/.config/nushell/env.nu" ] \
      && add_line "$HOME/.config/nushell/env.nu" \
        '$env.PATH = ($env.PATH | split row (char esep) | prepend ($env.HOME + "/.local/bin"))'
    for f in "$HOME/.tcshrc" "$HOME/.cshrc"; do
      [ -f "$f" ] || continue
      add_line "$f" 'set path = ( "$HOME/.local/bin" $path )'
    done

    # ── THIS terminal: a script piped from curl runs in a child shell and
    # cannot edit the parent shell's env — so instead drop a symlink into a
    # writable dir already on PATH. Conventional user-bin dirs are preferred
    # (keg dirs like /opt/homebrew/opt/*/bin get wiped on package upgrades);
    # then any other writable PATH dir; system dirs are excluded even if
    # writable.
    linked=""
    if command -v blinkwell >/dev/null 2>&1; then linked=skip; fi
    for pref in /opt/homebrew/bin /usr/local/bin; do
      [ -n "$linked" ] && break
      case ":$PATH:" in *":$pref:"*) ;; *) continue ;; esac
      [ "$pref" = "$bin_dir" ] && continue
      if [ -d "$pref" ] && [ -w "$pref" ] && [ ! -e "$pref/blinkwell" ] \
         && ln -s "$bin_dir/blinkwell" "$pref/blinkwell" 2>/dev/null; then
        linked="$pref"; break
      fi
    done
    oifs="$IFS"; IFS=':'
    for d in $PATH; do
      [ -n "$linked" ] && break
      case "$d" in
        ""|"$bin_dir"|/bin|/sbin|/usr/bin|/usr/sbin|/usr/local/bin|/usr/local/sbin|/snap/bin|/opt/local/bin) continue ;;
      esac
      if [ -d "$d" ] && [ -w "$d" ] && [ ! -e "$d/blinkwell" ] \
         && ln -s "$bin_dir/blinkwell" "$d/blinkwell" 2>/dev/null; then
        linked="$d"; break
      fi
    done
    IFS="$oifs"
    if [ "$linked" = skip ]; then
      echo "blinkwell: 'blinkwell' already resolves in this terminal"
    elif [ -n "$linked" ]; then
      echo "blinkwell: ready in THIS terminal too (via $linked)"
    else
      echo "blinkwell: in THIS terminal, run:  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
  fi

  # First run downloads libmediapipe (~12 MB, checksummed PyPI wheel) once.
  echo "blinkwell: done. Try: blinkwell"
fi
