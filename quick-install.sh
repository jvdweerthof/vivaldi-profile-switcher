#!/bin/bash
set -euo pipefail

# Bootstrap the full source archive, then hand off to the interactive installer.

ARCHIVE_URL="${VIVALDI_PROFILE_SWITCHER_ARCHIVE_URL:-https://github.com/jvdweerthof/vivaldi-profile-switcher/archive/refs/heads/main.tar.gz}"
CURL_BIN="${VIVALDI_PROFILE_SWITCHER_CURL:-/usr/bin/curl}"
TEMP_DIR=''

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" &&
        "$TEMP_DIR" == */vivaldi-profile-switcher-install.* ]]; then
    /bin/rm -rf -- "$TEMP_DIR"
  fi
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

TEMP_DIR="$(/usr/bin/mktemp -d -t vivaldi-profile-switcher-install)"
ARCHIVE="$TEMP_DIR/source.tar.gz"
SOURCE_DIR="$TEMP_DIR/source"

printf '\nDownloading Vivaldi Profile Switcher from GitHub...\n'
if ! "$CURL_BIN" --fail --location --silent --show-error \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 60 \
  --output "$ARCHIVE" "$ARCHIVE_URL"; then
  printf 'Could not download the installer. No Vivaldi files were changed.\n' >&2
  exit 1
fi

ARCHIVE_SIZE="$(/usr/bin/wc -c < "$ARCHIVE" | /usr/bin/tr -d ' ')"
if [[ "$ARCHIVE_SIZE" -lt 1000 || "$ARCHIVE_SIZE" -gt 5000000 ]]; then
  printf 'The downloaded archive has an unexpected size. No Vivaldi files were changed.\n' >&2
  exit 1
fi

/bin/mkdir "$SOURCE_DIR"
if ! /usr/bin/tar -xzf "$ARCHIVE" -C "$SOURCE_DIR" --strip-components=1; then
  printf 'Could not unpack the installer. No Vivaldi files were changed.\n' >&2
  exit 1
fi

INSTALLER="$SOURCE_DIR/Install.command"
MOD_SOURCE="$SOURCE_DIR/src/profile-switcher.js"
if [[ ! -f "$INSTALLER" || ! -f "$MOD_SOURCE" ]] ||
   ! /usr/bin/grep -Fq 'Vivaldi Profile Switcher Installer' "$INSTALLER" ||
   ! /usr/bin/grep -Fq 'Vivaldi Profile Switcher' "$MOD_SOURCE"; then
  printf 'The downloaded archive did not contain the expected installer files. No Vivaldi files were changed.\n' >&2
  exit 1
fi

if [[ -t 0 ]]; then
  /bin/bash "$INSTALLER"
elif { exec 3</dev/tty; } 2>/dev/null; then
  /bin/bash "$INSTALLER" <&3
else
  /bin/bash "$INSTALLER"
fi
