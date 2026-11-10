#!/bin/bash
set -euo pipefail

INSTALLER_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${VIVALDI_APP_PATH:-/Applications/Vivaldi.app}"
RESOURCE_DIR="$APP_PATH/Contents/Frameworks/Vivaldi Framework.framework/Versions/Current/Resources/vivaldi"
PAGE="$RESOURCE_DIR/window.html"
MOD_SOURCE="$INSTALLER_DIR/src/profile-switcher.js"
MOD_TARGET="$RESOURCE_DIR/profile-switcher.js"
LEGACY_MOD_TARGET="$RESOURCE_DIR/profile-swipe.js"
BACKUP="$RESOURCE_DIR/window.html.before-profile-switcher"
LEGACY_BACKUP="$RESOURCE_DIR/window.html.before-profile-swipe"
MARKER='<!-- profile-switcher installer -->'
LEGACY_MARKER='<!-- profile-swipe installer -->'
ENTRY='<script src="profile-switcher.js" defer></script><!-- profile-switcher installer -->'
DOWNLOADED_MOD=''
LATEST_MOD_URL='https://raw.githubusercontent.com/jvdweerthof/vivaldi-profile-switcher/main/src/profile-switcher.js'
CURL_BIN="${VIVALDI_PROFILE_SWITCHER_CURL:-/usr/bin/curl}"
MAXIMIZE_WINDOWS='false'

show_write_help() {
  printf '\nmacOS blocked writing inside Vivaldi.\n'
  printf 'This can be caused by App Management permission or file permissions.\n\n'
  printf 'Check System Settings > Privacy & Security > App Management.\n'
  printf 'Enable Terminal (or the terminal app running this installer), then\n'
  printf 'quit and reopen that terminal app and run this installer again.\n\n'
  printf 'This allows that terminal app to modify other applications.\n'
  printf 'You can turn the permission off again after installing.\n'
  printf 'If it is already enabled, do not grant broader access; check file permissions.\n'
}

write_or_explain() {
  if "$@"; then
    return 0
  else
    show_write_help
    exit 1
  fi
}

finish() {
  if [[ -n "$DOWNLOADED_MOD" && -f "$DOWNLOADED_MOD" ]]; then
    /bin/rm -f -- "$DOWNLOADED_MOD"
  fi
  printf '\nPress Return to close. '
  read -r _ || true
}
trap finish EXIT

latest_mod_from_github() {
  local file_size

  DOWNLOADED_MOD="$(/usr/bin/mktemp -t vivaldi-profile-switcher)"
  printf '\nDownloading the latest script from GitHub...\n'
  if ! "$CURL_BIN" --fail --location --silent --show-error \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 60 \
    --output "$DOWNLOADED_MOD" "$LATEST_MOD_URL"; then
    printf 'Could not download the latest version. No Vivaldi files were changed.\n'
    return 1
  fi

  file_size="$(/usr/bin/wc -c < "$DOWNLOADED_MOD" | /usr/bin/tr -d ' ')"
  if [[ "$file_size" -lt 1000 || "$file_size" -gt 200000 ]] ||
     ! /usr/bin/grep -Fq 'Vivaldi Profile Switcher' "$DOWNLOADED_MOD"; then
    printf 'The downloaded file did not pass validation. No Vivaldi files were changed.\n'
    return 1
  fi
  MOD_SOURCE="$DOWNLOADED_MOD"
}

choose_window_behavior() {
  local default_choice=1 behavior_choice

  if [[ -f "$MOD_TARGET" ]] &&
     /usr/bin/grep -Eq '^[[:space:]]*maximize: true,[[:space:]]*$' "$MOD_TARGET"; then
    default_choice=2
  elif /usr/bin/grep -Eq '^[[:space:]]*maximize: true,[[:space:]]*$' "$MOD_SOURCE"; then
    default_choice=2
  fi

  printf '\nWindow behavior:\n'
  printf '1) Keep each profile window’s size and position (switching may visibly jump)\n'
  printf '2) Maximize profile windows (not macOS full screen)\n'
  printf 'Choose [1–2] (default %s): ' "$default_choice"
  read -r behavior_choice || true
  behavior_choice="${behavior_choice:-$default_choice}"
  case "$behavior_choice" in
    1) MAXIMIZE_WINDOWS='false' ;;
    2) MAXIMIZE_WINDOWS='true' ;;
    *)
      printf 'Invalid choice; using default %s.\n' "$default_choice"
      if [[ "$default_choice" == 2 ]]; then
        MAXIMIZE_WINDOWS='true'
      else
        MAXIMIZE_WINDOWS='false'
      fi
      ;;
  esac
}

install_mod() {
  local temp_mod temp_page page_mode

  if [[ ! -f "$MOD_SOURCE" ]]; then
    printf 'Could not find the profile switcher script at:\n%s\n' "$MOD_SOURCE"
    return 1
  fi
  if ! /usr/bin/grep -q '</body>' "$PAGE"; then
    printf 'Unexpected startup file format. No changes made.\n'
    return 1
  fi

  # Stage complete files beside their targets, then replace them atomically.
  if ! temp_mod="$(/usr/bin/mktemp "$RESOURCE_DIR/.profile-swipe-js.XXXXXX")"; then
    show_write_help
    return 1
  fi
  if ! /usr/bin/awk -v maximize="$MAXIMIZE_WINDOWS" '
    /^[[:space:]]*maximize: (false|true),[[:space:]]*$/ {
      print "    maximize: " maximize ","
      configured++
      next
    }
    { print }
    END { if (configured != 1) exit 42 }
  ' "$MOD_SOURCE" > "$temp_mod"; then
    /bin/rm -f -- "$temp_mod"
    printf 'The profile switcher script has no supported window setting. No changes made.\n'
    return 1
  fi
  if [[ ! -f "$BACKUP" && ! -f "$LEGACY_BACKUP" ]]; then
    write_or_explain /bin/cp -p "$PAGE" "$BACKUP"
  fi
  if ! /bin/mv -f "$temp_mod" "$MOD_TARGET"; then
    /bin/rm -f -- "$temp_mod"
    show_write_help
    return 1
  fi

  if ! /usr/bin/grep -Fq "$ENTRY" "$PAGE"; then
    if ! temp_page="$(/usr/bin/mktemp "$RESOURCE_DIR/.profile-swipe-html.XXXXXX")"; then
      show_write_help
      return 1
    fi
    if ! /usr/bin/awk -v entry="$ENTRY" -v marker="$MARKER" \
      -v legacy_marker="$LEGACY_MARKER" '
      index($0, marker) || index($0, legacy_marker) {
        if (!inserted) { print entry; inserted=1 }
        next
      }
      /<\/body>/ && !inserted { print entry; inserted=1 }
      { print }
    ' "$PAGE" > "$temp_page"; then
      /bin/rm -f -- "$temp_page"
      printf 'Could not prepare Vivaldi’s startup file. No startup file changes were made.\n'
      return 1
    fi
    page_mode="$(/usr/bin/stat -f '%Lp' "$PAGE")"
    if ! /bin/chmod "$page_mode" "$temp_page" ||
       ! /usr/bin/touch -r "$PAGE" "$temp_page" ||
       ! /bin/mv -f "$temp_page" "$PAGE"; then
      /bin/rm -f -- "$temp_page"
      show_write_help
      return 1
    fi
  fi
  if [[ -f "$LEGACY_MOD_TARGET" ]]; then
    /bin/rm -f -- "$LEGACY_MOD_TARGET"
  fi
  printf '\nInstalled. Open Vivaldi normally; all profile windows load the mod.\n'
  printf 'Run this installer again after a Vivaldi update removes the mod.\n'
}

printf '\nVivaldi Profile Switcher Installer\n\n'
printf '1) Install the bundled version\n'
printf '2) Download the latest script from GitHub and install it\n'
printf '3) Uninstall the mod\n'
printf '4) Cancel\n\nChoose [1–4]: '
read -r choice
case "$choice" in
  1|2|3) ;;
  *) printf 'Cancelled.\n'; exit 0 ;;
esac

if [[ ! -f "$PAGE" ]]; then
  printf 'Could not find Vivaldi’s window.html at:\n%s\n' "$PAGE"
  exit 1
fi
if /usr/bin/pgrep -x Vivaldi >/dev/null 2>&1; then
  printf '\nQuit Vivaldi completely with Command-Q, then press Return. '
  read -r _
  if /usr/bin/pgrep -x Vivaldi >/dev/null 2>&1; then
    printf 'Vivaldi is still running. No changes made.\n'
    exit 1
  fi
fi
if [[ ! -w "$RESOURCE_DIR" || ! -w "$PAGE" ]]; then
  printf 'This Vivaldi installation is not writable. No changes made.\n'
  show_write_help
  exit 1
fi

if [[ "$choice" == 1 ]]; then
  choose_window_behavior
  install_mod
elif [[ "$choice" == 2 ]]; then
  latest_mod_from_github && choose_window_behavior && install_mod
else
  if /usr/bin/grep -Fq "$MARKER" "$PAGE" ||
     /usr/bin/grep -Fq "$LEGACY_MARKER" "$PAGE"; then
    if ! TEMP_PAGE="$(/usr/bin/mktemp "$RESOURCE_DIR/.profile-swipe.XXXXXX")"; then
      show_write_help
      exit 1
    fi
    if ! /usr/bin/awk -v marker="$MARKER" -v legacy_marker="$LEGACY_MARKER" \
      'index($0, marker)==0 && index($0, legacy_marker)==0 { print }' \
      "$PAGE" > "$TEMP_PAGE"; then
      /bin/rm -f -- "$TEMP_PAGE"
      printf 'Could not prepare Vivaldi’s startup file. No changes were made.\n'
      exit 1
    fi
    PAGE_MODE="$(/usr/bin/stat -f '%Lp' "$PAGE")"
    if ! /bin/chmod "$PAGE_MODE" "$TEMP_PAGE" ||
       ! /usr/bin/touch -r "$PAGE" "$TEMP_PAGE" ||
       ! /bin/mv -f "$TEMP_PAGE" "$PAGE"; then
      /bin/rm -f -- "$TEMP_PAGE"
      show_write_help
      exit 1
    fi
    if [[ -f "$MOD_TARGET" ]]; then /bin/rm "$MOD_TARGET"; fi
    if [[ -f "$LEGACY_MOD_TARGET" ]]; then /bin/rm "$LEGACY_MOD_TARGET"; fi
    printf '\nUninstalled. Other browser modifications were preserved.\n'
  else
    printf '\nNo installation made by this installer was found. No changes made.\n'
  fi
fi
