#!/bin/bash
set -euo pipefail

output=''
url=''

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    --connect-timeout|--max-time)
      shift 2
      ;;
    --fail|--location|--silent|--show-error|--tlsv1.2)
      shift
      ;;
    --proto|--proto-redir)
      [[ "$2" == '=https' ]]
      shift 2
      ;;
    https://*)
      url="$1"
      shift
      ;;
    *)
      printf 'Unexpected fake curl argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[[ -n "$output" && -n "$url" ]]
printf '%s\n' "$url" > "$FAKE_CURL_LOG"
/bin/cp "$FAKE_CURL_SCRIPT" "$output"
