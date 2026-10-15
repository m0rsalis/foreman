#!/bin/bash
# The full check through the shared queues, from the root of the checkout or
# worktree it runs in. The steps come from .claude/ops-kit.json: `fullCheck`
# (a list of {part, lock, command}; lock null runs without the queue) or, when
# absent, `checkCommand` under the `check` lock. Prints exactly one final line:
#   FULLCHECK: all green | FULLCHECK: <part> FAILED
# and exits non-zero on failure. Run it in the background with output to a
# log and read the last line; never hide its exit status behind a pipe.
# Each run also appends one JSON line to <main>/tmp/ops/checks.jsonl for the
# Ops panel (OPS_CHECKS_LOG overrides the file); that never changes the
# output or the exit code.
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
main=$(python3 -I "$here/ops_config.py" main) || exit 2
CHECKS_LOG="${OPS_CHECKS_LOG:-$main/tmp/ops/checks.jsonl}"
STARTED=$(date +%s)
record() { # result, part (a JSON string or null)
  {
    mkdir -p "$(dirname "$CHECKS_LOG")" &&
      printf '{"time":"%s","worktree":"%s","branch":"%s","commit":"%s","result":"%s","part":%s,"durationS":%d}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PWD" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" \
        "$(git rev-parse --short HEAD 2>/dev/null)" "$1" "$2" "$(($(date +%s) - STARTED))" >>"$CHECKS_LOG"
  } 2>/dev/null || true
}
steps=$(python3 -I "$here/ops_config.py" check-steps) || exit 2
if [ -z "$steps" ]; then
  echo "FULLCHECK: no check configured FAILED (set checkCommand or fullCheck in .claude/ops-kit.json)"
  record failed '"config"'
  exit 1
fi
while IFS= read -r step; do
  part=$(printf '%s' "$step" | python3 -c 'import json,sys; print(json.load(sys.stdin)["part"])')
  lock=$(printf '%s' "$step" | python3 -c 'import json,sys; print(json.load(sys.stdin)["lock"] or "")')
  cmd=$(printf '%s' "$step" | python3 -c 'import json,sys; print(json.load(sys.stdin)["command"])')
  if [ -n "$lock" ]; then
    "$here/queue.sh" "$lock" /bin/bash -c "$cmd" </dev/null
  else
    /bin/bash -c "$cmd" </dev/null
  fi || {
    echo "FULLCHECK: $part FAILED"
    record failed "$(printf '%s' "$part" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    exit 1
  }
done <<<"$steps"
echo "FULLCHECK: all green"
record green null
