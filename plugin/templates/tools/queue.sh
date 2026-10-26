#!/bin/bash
# Shared-resource queue for parallel agents (and people) on one machine.
#   queue.sh <lock> <command...>     run the command holding the named lock
# The locks are declared in .claude/ops-kit.json ("locks": name and timeoutMin),
# for example `check` for the full check or a database, `sim` for a simulator.
# First come, first served: each caller takes a ticket (a nanosecond
# timestamp) and runs when its ticket is the oldest and the lock is free.
# Tickets and locks of processes that died (or that outlived their limit, or
# that have no owner file) are cleared automatically, with a line saying so.
# Take one lock at a time; never call queue.sh while holding another.
#
# Every worktree and every session shares one lock folder in the main
# checkout (locksDir, default tmp/agent-locks, gitignored); OPS_AGENT_LOCKS
# overrides it. The layout (locks/<name>.lock, locks/<name>.queue) is what the
# Ops panel reads.
#
# Time limit: a job that runs longer than QUEUE_TIMEOUT_MIN minutes (default:
# the lock's timeoutMin; fractions allowed) is killed with its whole process
# group, the lock is released, one line says so and the exit code is 124.
# A caller whose worktree was deleted while it waited (queue_lock.py gone)
# removes its ticket, says so and exits 1. Every caller also clears the ticket
# of an alive owner whose queue.sh path (absolute, from its command line) no
# longer exists: that owner cannot take the lock, so it must not block the
# head. Tickets stay a bare pid in <time_ns>-<pid> files: copies of this
# script in older worktrees read them with cat and kill -0.
# Waiting callers print who holds the lock and for how long every 3 minutes.
set -u
here=$(cd "$(dirname "$0")" && pwd)
name=${1:?usage: queue.sh <lock> <command...>}
shift
[ $# -gt 0 ] || { echo "usage: queue.sh <lock> <command...>" >&2; exit 2; }
case "$name" in
  *[!A-Za-z0-9_-]* | -*) echo "queue.sh: bad lock name $name" >&2; exit 2 ;;
esac
limit=$(python3 -I "$here/ops_config.py" lock-timeout "$name") || { echo "queue.sh: $name is not a declared lock" >&2; exit 2; }
limit=${QUEUE_TIMEOUT_MIN:-$limit}
S=$(python3 -I "$here/ops_config.py" locks-dir) || exit 2
L="$S/locks/$name.lock"
Q="$S/locks/$name.queue"
mkdir -p "$Q"
ticket="$Q/$(python3 -c 'import time; print(time.time_ns())')-$$"
echo "$$" > "$ticket"

# Lock folder operations (acquire, release, clear a stale one) are atomic in
# queue_lock.py: a lock is never visible half written and a stale one is
# renamed aside before it is deleted.
cleanup() {
  rm -f "${ticket:?}"
  [ -f "$here/queue_lock.py" ] && python3 -I "$here/queue_lock.py" release "$L" "$$"
  return 0
}
child=""
# A signal kills the job (it runs in the background so the trap fires at once).
onsignal() {
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null && wait "$child" 2>/dev/null
  exit 143
}
trap cleanup EXIT
trap onsignal INT TERM

waited=0
# The absolute path of the queue.sh a process runs, from its command line
# (empty when it is not a queue.sh or the path is relative or has spaces).
script_of() {
  local w
  for w in $(ps -o command= -p "$1" 2>/dev/null); do
    case "$w" in /*queue.sh) echo "$w"; return ;; esac
  done
}
while true; do
  if [ ! -f "$here/queue_lock.py" ]; then
    echo "queue.sh: $name: my worktree $here is gone, leaving the queue" >&2
    exit 1
  fi
  for t in "$Q"/*; do
    [ -f "$t" ] || continue
    p=$(cat "$t" 2>/dev/null)
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then
      rm -f "${t:?}"
    elif [ -n "$p" ] && [ "$p" != "$$" ] && [ "$p" != "$(cat "${L:?}/owner" 2>/dev/null)" ]; then
      sp=$(script_of "$p")
      if [ -n "$sp" ] && [ ! -f "$sp" ]; then
        echo "queue.sh: cleared ticket of pid $p: its $sp is gone" >&2
        rm -f "${t:?}"
      fi
    fi
  done
  python3 -I "$here/queue_lock.py" reap "$L" "$limit"
  o=$(cat "${L:?}/owner" 2>/dev/null)
  head=$(ls "$Q" | sort | head -1)
  if [ "$Q/$head" = "$ticket" ] && python3 -I "$here/queue_lock.py" acquire "$L" "$$" "$limit" "$*"; then
    break
  fi
  if [ $((waited % 180)) -eq 0 ]; then
    since=$(cat "${L:?}/started" 2>/dev/null)
    held=""
    if [ -n "$since" ]; then
      held=", held by pid $o for $((($(date +%s) - since) / 60)) min: $(head -1 "$L/command" 2>/dev/null | cut -c1-100)"
    fi
    echo "queue.sh: waiting for $name ($(ls "$Q" | wc -l | tr -d ' ') in queue$held)" >&2
  fi
  sleep 5
  waited=$((waited + 5))
done
echo "queue.sh: $name acquired after ${waited}s" >&2
python3 -I "$here/queue_run.py" "$name" "$limit" "$@" <&0 &
child=$!
wait "$child"
code=$?
child=""
exit "$code"
