#!/bin/bash
# Tests for queue.sh: time limits, lock release, stale locks, FIFO without overlap.
# Installs the kit into a scratch repo with a private lock folder; takes about a minute.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
# A forced main check's variables must not leak into these.
unset FORCE_ALL FORCE_LINUX FULLCHECK_BRANCH
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

# --- A caller that cannot run never blocks the queue ---
# A throwaway copy of the scripts (inside the repo, where ops_config finds its checkout) stands in for a worktree that gets removed.
copy_scripts() { rm -rf "$1"; mkdir -p "$1"; cp "$repo"/tools/ops-kit/{queue.sh,queue_lock.py,queue_run.py,ops_config.py} "$1"/; }
wait_gone() { for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done; }
Qd="$OPS_AGENT_LOCKS/locks/sim.queue"
rm -rf "$LK" "$Qd"

# A waiter whose script folder is deleted leaves, and the one behind it runs.
X="$repo/tools/gone-worktree"; copy_scripts "$X"
"$Q" sim sleep 9 >/dev/null 2>&1 &
sleep 1
"$X/queue.sh" sim echo never >"$OPS_AGENT_LOCKS/xout" 2>"$OPS_AGENT_LOCKS/xerr" &
xp=$!
sleep 1
"$Q" sim echo behind >"$OPS_AGENT_LOCKS/yout" 2>/dev/null &
yp=$!
sleep 1
rm -rf "$X"
wait_gone "$xp"
wait "$xp" 2>/dev/null; xc=$?
check "gone worktree: waiter exits non-zero" "$([ "$xc" -ne 0 ] && echo yes || echo no)" yes
# Under load the waiter behind may clear this one first (kill -9, no message).
case "$(cat "$OPS_AGENT_LOCKS/xerr")" in *"my worktree $X is gone, leaving the queue"*) r=yes ;; *) if [ "$xc" -eq 137 ]; then r=yes; else r=no; fi ;; esac
check "gone worktree: says so" "$r" yes
check "gone worktree: never ran" "$(cat "$OPS_AGENT_LOCKS/xout")" ""
# shellcheck disable=SC2010  # names are our own, plain ASCII
check "gone worktree: ticket removed" "$(ls "$Qd" | grep -c -e "-$xp\$")" 0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do kill -0 "$yp" 2>/dev/null || break; sleep 1; done
check "gone worktree: next caller ran" "$(cat "$OPS_AGENT_LOCKS/yout")" behind
wait

# An alive owner whose queue.sh path is gone, at the head of the queue, is cleared.
mkdir -p "$Qd"
sh -c 'sleep 60; :' /nonexistent/worktree/queue.sh & ghost=$!
echo "$ghost" > "$Qd/1-$ghost"
out=$("$Q" sim echo ran 2>"$OPS_AGENT_LOCKS/err")
check "gone script owner: waiter proceeds" "$out" ran
case "$(cat "$OPS_AGENT_LOCKS/err")" in *"cleared ticket of pid $ghost"*) r=yes ;; *) r=no ;; esac
check "gone script owner: says so" "$r" yes
check "gone script owner: process untouched" "$(kill -0 "$ghost" 2>/dev/null && echo alive || echo dead)" alive
kill "$ghost" 2>/dev/null; wait "$ghost" 2>/dev/null

# Tickets keep their format (<time_ns>-<pid>, content the bare pid) and an
# older copy's ticket (an alive pid, no queue.sh path) is honoured.
sleep 30 & old=$!
echo "$old" > "$Qd/1-$old"
"$Q" sim echo ran >"$OPS_AGENT_LOCKS/out" 2>/dev/null &
wp=$!
sleep 7
check "old-format head ticket: honoured" "$(cat "$OPS_AGENT_LOCKS/out")" ""
# shellcheck disable=SC2010  # names are our own, plain ASCII
mine=$(ls "$Qd" | grep -v -e "^1-")
case "$mine" in [0-9]*-$wp) r=yes ;; *) r="no ($mine)" ;; esac
check "ticket name is <time_ns>-<pid>" "$r" yes
check "ticket content is the bare pid" "$(cat "$Qd/$mine")" "$wp"
kill "$old" 2>/dev/null; wait "$old" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8; do kill -0 "$wp" 2>/dev/null || break; sleep 1; done
check "old-format head ticket: waiter runs once it dies" "$(cat "$OPS_AGENT_LOCKS/out")" ran
wait

exit $fail
