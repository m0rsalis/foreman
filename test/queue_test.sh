#!/bin/bash
# Tests for queue.sh: time limits, lock release, stale locks, FIFO without overlap.
# Installs the kit into a scratch repo with a private lock folder; takes about a minute.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
repo=$(make_repo)
python3 "$INIT" --repo "$repo" --owner Test --locks check:120,sim:45 >/dev/null || { echo "FAIL: init"; exit 1; }
OPS_AGENT_LOCKS=$(mktemp -d)
export OPS_AGENT_LOCKS
trap 'rm -rf "$repo" "$OPS_AGENT_LOCKS"' EXIT
Q="$repo/tools/ops-kit/queue.sh"
lock_state() { if [ -d "$OPS_AGENT_LOCKS/locks/sim.lock" ]; then echo held; else echo free; fi; }
alive() { if kill -0 "$(cat "$1")" 2>/dev/null; then echo alive; else echo dead; fi; }

# Only declared locks, and only plain names.
"$Q" nope echo x >/dev/null 2>&1
check "undeclared lock refused" "$?" 2
"$Q" ../x echo x >/dev/null 2>&1
check "path as lock name refused" "$?" 2
"$Q" sim >/dev/null 2>&1
check "no command refused" "$?" 2

# Without OPS_AGENT_LOCKS the locks live in the main checkout's tmp/agent-locks.
out=$(OPS_AGENT_LOCKS='' "$Q" check sh -c 'ls "$0"' "$repo/tmp/agent-locks/locks" 2>/dev/null | tr '\n' ' ')
contains "default lock folder in the main checkout" "$out" "check.lock"

# A normal job is unaffected: output and exit code pass through, lock freed.
out=$("$Q" sim sh -c 'echo hello; exit 7' 2>/dev/null)
code=$?
check "normal job exit code" "$code" 7
check "normal job output" "$out" hello
check "normal job releases lock" "$(lock_state)" free

# A job over the limit is killed with its whole group.
marker="$OPS_AGENT_LOCKS/grandchild"
msg=$(QUEUE_TIMEOUT_MIN=0.03 "$Q" sim sh -c "sleep 61 & echo \$! > $marker; wait" 2>&1 >/dev/null)
code=$?
check "timeout exit code" "$code" 124
case "$msg" in *"queue.sh: sim job timed out after 0.03 min: sh -c"*) r=yes ;; *) r=no ;; esac
check "timeout message" "$r" yes
check "timeout releases lock" "$(lock_state)" free
check "timeout kills grandchild" "$(alive "$marker")" dead

# The next waiter proceeds after a timeout.
QUEUE_TIMEOUT_MIN=0.03 "$Q" sim sleep 61 >/dev/null 2>&1 &
sleep 1
out=$("$Q" sim echo next 2>/dev/null)
check "waiter runs after timeout" "$out" next
wait

# SIGTERM to queue.sh kills the job and frees the lock.
"$Q" sim sh -c "sleep 62 & echo \$! > $marker; wait" >/dev/null 2>&1 &
qp=$!
sleep 2
kill -TERM "$qp"
wait "$qp" 2>/dev/null
check "sigterm releases lock" "$(lock_state)" free
check "sigterm kills job" "$(alive "$marker")" dead

# Stale locks never deadlock the queue.
LK="$OPS_AGENT_LOCKS/locks/sim.lock"
mk_lock() { # owner-or-empty, started
  rm -rf "$LK"; mkdir -p "$LK"
  echo "old job" > "$LK/command"
  echo "$2" > "$LK/started"
  if [ -n "$1" ]; then echo "$1" > "$LK/owner"; fi
  touch -t 202001010000 "$LK"
}
export QUEUE_OWNERLESS_GRACE=1

# An owner-less folder (the old layout after its owner file was removed) is cleared.
mk_lock "" "$(date +%s)"
out=$("$Q" sim echo ran 2>"$OPS_AGENT_LOCKS/err")
check "owner-less lock: waiter proceeds" "$out" ran
case "$(cat "$OPS_AGENT_LOCKS/err")" in *"cleared stale lock sim.lock (owner none: no owner file"*) r=yes ;; *) r=no ;; esac
check "owner-less lock: says so" "$r" yes
check "owner-less lock: freed" "$(lock_state)" free

# A dead owner is cleared.
sh -c 'exit 0' & dead=$!; wait "$dead"
mk_lock "$dead" "$(date +%s)"
out=$("$Q" sim echo ran 2>"$OPS_AGENT_LOCKS/err")
check "dead owner: waiter proceeds" "$out" ran
case "$(cat "$OPS_AGENT_LOCKS/err")" in *"owner pid $dead is dead"*) r=yes ;; *) r=no ;; esac
check "dead owner: says so" "$r" yes

# A live owner is never cleared, however long the waiter waits.
sleep 30 & live=$!
mk_lock "$live" "$(date +%s)"
"$Q" sim echo ran >"$OPS_AGENT_LOCKS/out" 2>/dev/null &
wp=$!
sleep 7
check "live owner: lock kept" "$(cat "$LK/owner" 2>/dev/null)" "$live"
check "live owner: waiter still waiting" "$(cat "$OPS_AGENT_LOCKS/out")" ""
kill "$wp" 2>/dev/null; wait "$wp" 2>/dev/null
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
rm -rf "$LK"

# A live owner past its limit plus the margin is stale.
sleep 120 & live=$!
mk_lock "$live" "$(( $(date +%s) - 700 ))"
printf "old job\n1\n" > "$LK/command"
"$Q" sim echo ran >"$OPS_AGENT_LOCKS/out" 2>/dev/null &
wp=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$wp" 2>/dev/null || break; sleep 1; done
check "over-limit owner: waiter proceeded while owner lives" "$(cat "$OPS_AGENT_LOCKS/out")" ran
kill "$wp" 2>/dev/null; wait "$wp" 2>/dev/null
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null

# Two waiters racing to clear one stale lock leave one valid lock: jobs never overlap.
mk_lock "" "$(date +%s)"
log="$OPS_AGENT_LOCKS/race.log"; : > "$log"
job="echo start >> $log; sleep 1; echo end >> $log"
"$Q" sim sh -c "$job" >/dev/null 2>&1 &
w1=$!
"$Q" sim sh -c "$job" >/dev/null 2>&1 &
w2=$!
wait "$w1" "$w2"
check "race: both jobs ran in turn" "$(tr '\n' ' ' < "$log")" "start end start end "
check "race: lock freed" "$(lock_state)" free

exit $fail
