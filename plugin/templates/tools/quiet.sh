#!/bin/bash
# Runs a command with its full output in a log file and prints only a short
# summary: the exit code, the log's path, error-looking lines (at most 40) and
# the last 15 lines. Exits with the command's own exit code.
#
#   quiet.sh <name> <command> [args...]
#
# Why: every line a command prints stays in an agent's context and is re-read
# on every later call. Shell output was nine tenths of what entered agents'
# contexts (the rules' "Token budget"). Read the
# log by range (grep, sed -n) when the summary is not enough.
#
# The log goes to <worktree>/tmp/logs/<name>.log (overwritten each run;
# QUIET_LOG_DIR overrides the folder). Compose with the queues:
#   quiet.sh gpu queue.sh check make test
if [ $# -lt 2 ]; then
  echo "usage: $0 <name> <command> [args...]" >&2
  exit 2
fi
name=$1
shift
top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
dir=${QUIET_LOG_DIR:-$top/tmp/logs}
mkdir -p "$dir"
log="$dir/$name.log"
start=$(date +%s)
"$@" >"$log" 2>&1
code=$?
secs=$(($(date +%s) - start))
lines=$(wc -l <"$log" | tr -d ' ')
echo "QUIET $name: exit $code after ${secs}s, $lines lines in $log"
# Error-looking lines first, so a failure is visible without opening the log.
errors=$(grep -n -E 'error|Error|ERROR|FAIL|Failed|failed|Exception|Some tests failed|\[E\]|✗' "$log" | head -40)
if [ -n "$errors" ]; then
  echo "-- error-looking lines (first 40):"
  echo "$errors"
fi
echo "-- last 15 lines:"
tail -n 15 "$log"
exit $code
