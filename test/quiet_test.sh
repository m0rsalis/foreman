#!/bin/bash
# Tests for quiet.sh: exit codes pass through, the full output lands in the
# log, and the summary stays short.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
QUIET_LOG_DIR=$(mktemp -d)
export QUIET_LOG_DIR
trap 'rm -rf "$QUIET_LOG_DIR"' EXIT
Q="$KIT/plugin/templates/tools/quiet.sh"

# A long, passing command: exit 0, all 500 lines in the log, few printed.
out=$(bash "$Q" ok sh -c 'i=0; while [ $i -lt 500 ]; do echo "line $i"; i=$((i+1)); done')
code=$?
check "passing exit code" "$code" 0
check "full output in the log" "$(wc -l <"$QUIET_LOG_DIR/ok.log" | tr -d ' ')" 500
check "summary is short" "$([ "$(echo "$out" | wc -l)" -le 20 ] && echo short || echo long)" short
check "summary ends with the last line" "$(echo "$out" | tail -n 1)" "line 499"

# A failing command: its exit code passes through and the error line shows,
# even when it scrolled far above the tail.
out=$(bash "$Q" bad sh -c 'echo "Error: boom"; i=0; while [ $i -lt 100 ]; do echo x; i=$((i+1)); done; exit 3')
code=$?
check "failing exit code" "$code" 3
check "error line surfaced" "$(echo "$out" | grep -c 'Error: boom')" 1

# Usage error without a command.
bash "$Q" only-name >/dev/null 2>&1
check "usage exit code" "$?" 2

exit $fail
