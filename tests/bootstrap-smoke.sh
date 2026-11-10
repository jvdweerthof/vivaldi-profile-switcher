#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP="$REPO_ROOT/quick-install.sh"
TEST_ROOT="$(/usr/bin/mktemp -d -t vivaldi-profile-switcher-bootstrap-test)"
ARCHIVE_ROOT="$TEST_ROOT/archive/vivaldi-profile-switcher-main"
ARCHIVE="$TEST_ROOT/source.tar.gz"
APP_PATH="$TEST_ROOT/Vivaldi.app"
RESOURCE_DIR="$APP_PATH/Contents/Frameworks/Vivaldi Framework.framework/Versions/Current/Resources/vivaldi"
PAGE="$RESOURCE_DIR/window.html"
FAKE_CURL_LOG="$TEST_ROOT/curl.log"
TEMP_PARENT="$TEST_ROOT/tmp"

cleanup() {
  if [[ -d "$TEST_ROOT" && "$TEST_ROOT" == */vivaldi-profile-switcher-bootstrap-test.* ]]; then
    /bin/rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

/bin/mkdir -p "$ARCHIVE_ROOT/src" "$RESOURCE_DIR" "$TEMP_PARENT"
/bin/cp "$REPO_ROOT/Install.command" "$ARCHIVE_ROOT/Install.command"
/bin/cp "$REPO_ROOT/src/profile-switcher.js" "$ARCHIVE_ROOT/src/profile-switcher.js"
/usr/bin/tar -czf "$ARCHIVE" -C "$TEST_ROOT/archive" vivaldi-profile-switcher-main
printf '<!doctype html>\n<body>\n<p>bootstrap fixture</p>\n</body>\n' > "$PAGE"

printf '1\n\n\n' | \
  VIVALDI_PROFILE_SWITCHER_CURL="$REPO_ROOT/tests/fake-curl.sh" \
  VIVALDI_PROFILE_SWITCHER_ARCHIVE_URL='https://example.test/source.tar.gz' \
  FAKE_CURL_SCRIPT="$ARCHIVE" \
  FAKE_CURL_LOG="$FAKE_CURL_LOG" \
  VIVALDI_APP_PATH="$APP_PATH" \
  TMPDIR="$TEMP_PARENT" \
  /bin/bash "$BOOTSTRAP" >/dev/null

/usr/bin/grep -Fq '<!-- profile-switcher installer -->' "$PAGE"
/usr/bin/cmp -s "$REPO_ROOT/src/profile-switcher.js" "$RESOURCE_DIR/profile-switcher.js"
/usr/bin/grep -Fxq 'https://example.test/source.tar.gz' "$FAKE_CURL_LOG"
if [[ -n "$(/bin/ls -A "$TEMP_PARENT")" ]]; then
  printf 'Bootstrap left temporary files behind.\n' >&2
  exit 1
fi

printf 'Bootstrap smoke test passed.\n'
