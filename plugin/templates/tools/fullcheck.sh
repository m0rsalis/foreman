#!/bin/bash
# The full check through the shared queues, from the root of the checkout or
# worktree it runs in. The steps come from .claude/foreman.json: `fullCheck`
# (a list of {part, lock, command, cache}; lock null runs without the queue)
# or, when absent, `checkCommand` under the `check` lock. Prints exactly one
# final line:
#   FULLCHECK: all green at <short sha> (<n> of <m> steps cached)
#   FULLCHECK: all green at <short sha> + uncommitted changes (...)
#   FULLCHECK: <part> FAILED
# The green line names the commit it checked: merge only on a line that names
# the PR's head commit. If HEAD or the tracked files changed during the run it
# says "all green at <sha>, but HEAD is now <sha>" (or "... but the working
# tree changed") and exits 1: rerun before merging. Exits non-zero on
# failure. Run it in the background with output to a log and read the last
# line; never hide its exit status behind a pipe.
#
# Suite cache (suite_cache.py): on a clean worktree a step that has a `cache`
# object and already passed on the same inputs prints "STEP <part> cached" and
# is skipped, without joining its queue. FORCE_ALL=1 runs every step and
# still records the greens. The cache lives in <main>/tmp/ops/suite-cache/
# (SUITE_CACHE_DIR overrides). A step that prints a line "foreman: no-cache"
# was gated off (it ran nothing real) and is not recorded.
#
# Each run also appends one JSON line to <main>/tmp/ops/checks.jsonl for the
# Ops panel (OPS_CHECKS_LOG overrides the file; "cached" is the number of
# cached steps); that never changes the output or the exit code. Each step
# prints "STEP <part> <seconds>s"; the run's step times (and the cached steps'
# names) go as one JSON line to <main>/tmp/ops/check-steps.jsonl
# (OPS_STEPS_LOG overrides).
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
main=$(python3 -I "$here/ops_config.py" main) || exit 2
SC="$here/suite_cache.py"
CHECKS_LOG="${OPS_CHECKS_LOG:-$main/tmp/ops/checks.jsonl}"
STEPS_LOG="${OPS_STEPS_LOG:-$main/tmp/ops/check-steps.jsonl}"
export SUITE_CACHE_DIR="${SUITE_CACHE_DIR:-$main/tmp/ops/suite-cache}"
STEPS_FILE=$(mktemp)
LOG=$(mktemp)
trap 'rm -f "$STEPS_FILE" "$LOG"' EXIT
STARTED=$(date +%s)
state() { # HEAD sha and a digest of the tracked changes against it
  printf '%s %s' "$(git rev-parse --short HEAD 2>/dev/null)" "$(git diff HEAD 2>/dev/null | shasum | cut -c1-12)"
}
START_SHA=$(git rev-parse --short HEAD 2>/dev/null)
START_HEAD=$(git rev-parse HEAD 2>/dev/null)
START_STATE=$(state)
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then CLEAN=true; else CLEAN=false; fi
ncached() { grep -c ' cached$' "$STEPS_FILE" 2>/dev/null; }
json_string() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }
record() { # result, part (a JSON string or null)
  {
    mkdir -p "$(dirname "$CHECKS_LOG")" "$(dirname "$STEPS_LOG")" &&
      printf '{"time":"%s","worktree":"%s","branch":"%s","commit":"%s","clean":%s,"result":"%s","part":%s,"durationS":%d,"cached":%d}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PWD" "${FULLCHECK_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}" \
        "$START_SHA" "$CLEAN" "$1" "$2" "$(($(date +%s) - STARTED))" "$(ncached)" >>"$CHECKS_LOG"
    printf '{"time":"%s","branch":"%s","commit":"%s","result":"%s","steps":{%s},"cached":[%s]}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${FULLCHECK_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}" \
      "$START_SHA" "$1" "$("$here/steps_json.sh" "$STEPS_FILE")" "$("$here/steps_json.sh" --cached "$STEPS_FILE")" >>"$STEPS_LOG"
  } 2>/dev/null || true
}
steps=$(python3 -I "$here/ops_config.py" check-steps) || exit 2
if [ -z "$steps" ]; then
  echo "FULLCHECK: no check configured FAILED (set checkCommand or fullCheck in .claude/foreman.json)"
  record failed '"config"'
  exit 1
fi
TOTAL=$(printf '%s\n' "$steps" | wc -l | tr -d ' ')
field() { printf '%s' "$1" | python3 -c 'import json,sys; v=json.load(sys.stdin)[sys.argv[1]]; print(v if isinstance(v,str) else "")' "$2"; }
usable=false
if python3 -I "$SC" usable 2>/dev/null; then usable=true; fi
while IFS= read -r step; do
  part=$(field "$step" part)
  lock=$(field "$step" lock)
  cmd=$(field "$step" command)
  name=${part// /_}
  fp=""
  if $usable; then
    # Exit 3 (no `cache` on the step) leaves fp empty: the step always runs.
    fp=$(python3 -I "$SC" fingerprint "$part" 2>/dev/null)
    if [ -n "$fp" ] && python3 -I "$SC" hit "$fp"; then
      echo "STEP $name cached"
      echo "$name cached" >>"$STEPS_FILE"
      continue
    fi
  fi
  s=$(date +%s)
  : >"$LOG"
  if [ -n "$lock" ]; then
    "$here/queue.sh" "$lock" /bin/bash -c "$cmd" </dev/null 2>&1 | tee "$LOG"
  else
    /bin/bash -c "$cmd" </dev/null 2>&1 | tee "$LOG"
  fi
  rc=${PIPESTATUS[0]}
  d=$(($(date +%s) - s))
  echo "STEP $name ${d}s"
  echo "$name $d" >>"$STEPS_FILE"
  if [ "$rc" -ne 0 ]; then
    echo "FULLCHECK: $part FAILED"
    record failed "$(json_string "$part")"
    exit 1
  fi
  # Record only if HEAD did not move and the tree is still clean: then the
  # fingerprint is exactly what the step saw.
  if [ -n "$fp" ] && [ "$(git rev-parse HEAD 2>/dev/null)" = "$START_HEAD" ] &&
    python3 -I "$SC" usable 2>/dev/null && ! grep -q '^foreman: no-cache' "$LOG"; then
    python3 -I "$SC" record "$fp" "$part" "$d" 2>/dev/null || true
  fi
done <<<"$steps"
END_SHA=$(git rev-parse --short HEAD 2>/dev/null)
if [ "$END_SHA" != "$START_SHA" ]; then
  echo "FULLCHECK: all green at $START_SHA, but HEAD is now $END_SHA: rerun before merging"
  record moved null
  exit 1
elif [ "$(state)" != "$START_STATE" ]; then
  echo "FULLCHECK: all green at $START_SHA, but the working tree changed during the run: rerun before merging"
  record moved null
  exit 1
fi
summary="($(ncached) of $TOTAL steps cached)"
if $CLEAN; then echo "FULLCHECK: all green at $START_SHA $summary"; else echo "FULLCHECK: all green at $START_SHA + uncommitted changes $summary"; fi
record green null
