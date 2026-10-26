#!/bin/bash
# The safety net under the suite cache: an unconditional full check
# (FORCE_ALL=1: every step runs) of origin/<mainBranch>, in a dedicated
# detached worktree, through the queues like any check. Its greens seed the
# shared cache, so a branch rechecked after merging main finds main's steps
# cached.
#   main_fullcheck.sh        from any checkout or worktree
# The worktree is <main>/.claude/worktrees/main-check: reused (its build
# caches stay warm), never on a branch, reset to the ref each run; the lead
# never removes it. One run at a time (<main>/tmp/ops/main-check.pid). The
# run's output goes to <main>/tmp/logs/main-check.log; its result is the
# checks.jsonl line with the main branch's name (fullcheck.sh,
# FULLCHECK_BRANCH) and the last line printed here. The heartbeat starts it
# when main moved and the check queue is empty (needs_lead.py).
# MAIN_CHECK_WORKTREE and MAIN_CHECK_REF override (tests).
set -u
here=$(cd "$(dirname "$0")" && pwd)
main=$(python3 -I "$here/ops_config.py" main) || exit 2
branch=$(python3 -I "$here/ops_config.py" get mainBranch 2>/dev/null) || branch=main
wt=${MAIN_CHECK_WORKTREE:-$main/.claude/worktrees/main-check}
ref=${MAIN_CHECK_REF:-origin/$branch}
pidf="$main/tmp/ops/main-check.pid"
log="$main/tmp/logs/main-check.log"
tools=$(python3 -I "$here/ops_config.py" get toolsDir 2>/dev/null) || tools=tools/ops-kit
mkdir -p "$main/tmp/ops" "$main/tmp/logs"
if [ -f "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null; then
  echo "main_fullcheck: already running (pid $(cat "$pidf"))"
  exit 0
fi
echo $$ >"$pidf"
trap 'rm -f "$pidf"' EXIT
git -C "$main" fetch -q origin "$branch" || { echo "main_fullcheck: fetch FAILED"; exit 1; }
if [ ! -e "$wt/.git" ]; then
  git -C "$main" worktree add -q --detach "$wt" "$ref" || { echo "main_fullcheck: worktree add FAILED"; exit 1; }
else
  # Ours alone: drop whatever a previous run left (tracked or untracked, not
  # the ignored build caches) and move to the ref.
  git -C "$wt" checkout -q --force --detach "$ref" && git -C "$wt" clean -fdq ||
    { echo "main_fullcheck: reset FAILED"; exit 1; }
fi
echo "main_fullcheck: checking $(git -C "$wt" rev-parse --short HEAD) in $wt (log $log)"
(cd "$wt" && FORCE_ALL=1 FULLCHECK_BRANCH="$branch" "$tools/fullcheck.sh") >"$log" 2>&1
rc=$?
tail -n 1 "$log"
exit $rc
