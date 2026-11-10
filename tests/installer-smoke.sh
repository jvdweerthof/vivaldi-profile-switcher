#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/Install.command"
SOURCE="$REPO_ROOT/src/profile-switcher.js"
TEST_ROOT="$(/usr/bin/mktemp -d -t vivaldi-profile-switcher-test)"
APP_PATH="$TEST_ROOT/Vivaldi.app"
RESOURCE_DIR="$APP_PATH/Contents/Frameworks/Vivaldi Framework.framework/Versions/Current/Resources/vivaldi"
PAGE="$RESOURCE_DIR/window.html"
REMOTE_SCRIPT="$TEST_ROOT/remote-profile-switcher.js"
FAKE_CURL_LOG="$TEST_ROOT/curl.log"

cleanup() {
  if [[ -d "$TEST_ROOT" && "$TEST_ROOT" == */vivaldi-profile-switcher-test.* ]]; then
    /bin/rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

/bin/mkdir -p "$RESOURCE_DIR"
printf '<!doctype html>\n<body>\n<p>fixture</p>\n</body>\n' > "$PAGE"

printf '1\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null
/usr/bin/grep -Fq '<!-- profile-switcher installer -->' "$PAGE"
/usr/bin/cmp -s "$SOURCE" "$RESOURCE_DIR/profile-switcher.js"
[[ -f "$RESOURCE_DIR/window.html.before-profile-switcher" ]]

# The optional setup choice writes a configured copy without changing the source.
printf '1\n2\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null
/usr/bin/grep -Eq '^[[:space:]]*maximize: true,[[:space:]]*$' \
  "$RESOURCE_DIR/profile-switcher.js"
/usr/bin/grep -Eq '^[[:space:]]*maximize: false,[[:space:]]*$' "$SOURCE"

# Pressing Return on an update preserves an installed maximize choice.
printf '1\n\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null
/usr/bin/grep -Eq '^[[:space:]]*maximize: true,[[:space:]]*$' \
  "$RESOURCE_DIR/profile-switcher.js"

# An invalid response keeps the displayed default instead of changing behavior.
printf '1\n9\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null
/usr/bin/grep -Eq '^[[:space:]]*maximize: true,[[:space:]]*$' \
  "$RESOURCE_DIR/profile-switcher.js"

printf '3\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null
if /usr/bin/grep -Fq '<!-- profile-switcher installer -->' "$PAGE"; then
  printf 'Uninstall left the profile switcher marker behind.\n' >&2
  exit 1
fi
[[ ! -e "$RESOURCE_DIR/profile-switcher.js" ]]
/usr/bin/grep -Fq '<p>fixture</p>' "$PAGE"

# Confirm that reinstalling migrates the original filename and marker.
/usr/bin/awk '
  /<\/body>/ { print "<script src=\"profile-swipe.js\" defer></script><!-- profile-swipe installer -->" }
  { print }
' "$PAGE" > "$TEST_ROOT/legacy-window.html"
/bin/mv "$TEST_ROOT/legacy-window.html" "$PAGE"
printf 'legacy fixture\n' > "$RESOURCE_DIR/profile-swipe.js"
printf '1\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null
/usr/bin/grep -Fq '<!-- profile-switcher installer -->' "$PAGE"
if /usr/bin/grep -Fq '<!-- profile-swipe installer -->' "$PAGE"; then
  printf 'Install left the legacy marker behind.\n' >&2
  exit 1
fi
[[ ! -e "$RESOURCE_DIR/profile-swipe.js" ]]
/usr/bin/cmp -s "$SOURCE" "$RESOURCE_DIR/profile-switcher.js"

printf '3\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null

/bin/cp "$SOURCE" "$REMOTE_SCRIPT"
printf '\n// Installed from the fake GitHub response during the smoke test.\n' >> "$REMOTE_SCRIPT"
/bin/chmod +x "$REPO_ROOT/tests/fake-curl.sh"

printf '2\n\n' | \
  VIVALDI_PROFILE_SWITCHER_CURL="$REPO_ROOT/tests/fake-curl.sh" \
  FAKE_CURL_SCRIPT="$REMOTE_SCRIPT" \
  FAKE_CURL_LOG="$FAKE_CURL_LOG" \
  VIVALDI_APP_PATH="$APP_PATH" \
  "$INSTALLER" >/dev/null
/usr/bin/cmp -s "$REMOTE_SCRIPT" "$RESOURCE_DIR/profile-switcher.js"
/usr/bin/grep -Fq '<!-- profile-switcher installer -->' "$PAGE"
/usr/bin/grep -Fq 'https://raw.githubusercontent.com/jvdweerthof/vivaldi-profile-switcher/main/src/profile-switcher.js' "$FAKE_CURL_LOG"

# The downloaded path applies the same maximize choice to its staged copy.
printf '2\n2\n\n' | \
  VIVALDI_PROFILE_SWITCHER_CURL="$REPO_ROOT/tests/fake-curl.sh" \
  FAKE_CURL_SCRIPT="$REMOTE_SCRIPT" \
  FAKE_CURL_LOG="$FAKE_CURL_LOG" \
  VIVALDI_APP_PATH="$APP_PATH" \
  "$INSTALLER" >/dev/null
/usr/bin/grep -Eq '^[[:space:]]*maximize: true,[[:space:]]*$' \
  "$RESOURCE_DIR/profile-switcher.js"
/usr/bin/grep -Fq 'Installed from the fake GitHub response' \
  "$RESOURCE_DIR/profile-switcher.js"

printf '3\n\n' | VIVALDI_APP_PATH="$APP_PATH" "$INSTALLER" >/dev/null
[[ ! -e "$RESOURCE_DIR/profile-switcher.js" ]]

# Reject an invalid download before changing Vivaldi.
printf 'not the profile switcher\n' > "$REMOTE_SCRIPT"
if printf '2\n\n' | \
  VIVALDI_PROFILE_SWITCHER_CURL="$REPO_ROOT/tests/fake-curl.sh" \
  FAKE_CURL_SCRIPT="$REMOTE_SCRIPT" \
  FAKE_CURL_LOG="$FAKE_CURL_LOG" \
  VIVALDI_APP_PATH="$APP_PATH" \
  "$INSTALLER" >/dev/null; then
  printf 'Installer accepted an invalid download.\n' >&2
  exit 1
fi
[[ ! -e "$RESOURCE_DIR/profile-switcher.js" ]]
if /usr/bin/grep -Fq '<!-- profile-switcher installer -->' "$PAGE"; then
  printf 'Invalid download changed the Vivaldi startup file.\n' >&2
  exit 1
fi

printf 'Installer smoke test passed.\n'
