#!/bin/bash
# Tests for needs_lead.py (make test-tools): the heartbeat wakes the lead on a
# change or after the quiet limit, and stays silent otherwise.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
repo=$(make_repo)
t=$(mktemp -d)
trap 'rm -rf "$t" "$repo"' EXIT
python3 "$INIT" --repo "$repo" --owner Sam --slug demo >/dev/null || { echo "FAIL: init"; exit 1; }
# A config of its own: the second account on (its list is read), no lanes yet.
echo '{"heartbeatName":"demo-heartbeat","agentsAccount":true}' >"$t/config.json"
export NEEDS_LEAD_AGENTS=$t/agents.json NEEDS_LEAD_AGENTS2=$t/agents2.json NEEDS_LEAD_PRS=$t/prs.json \
  NEEDS_LEAD_BACKLOG=$t/backlog.json NEEDS_LEAD_STATE=$t/state.json NEEDS_LEAD_USAGE=$t/usage \
  NEEDS_LEAD_SESSIONS=$t/sessions NEEDS_LEAD_PS=$t/ps.txt NEEDS_LEAD_CONFIG=$t/config.json
# An empty session registry and process table: the stall check must never
# read the machine's live agents (a real agent's long command broke "first
# run notifies").
mkdir "$t/usage" "$t/sessions"
: >"$t/ps.txt"
N="python3 $repo/tools/ops-kit/needs_lead.py"
# Overrides lib.sh's exact check: the expectation is a glob pattern here.
# shellcheck disable=SC2254  # the expected value is a glob on purpose
check() { case "$2" in $3) echo "ok: $1" ;; *) echo "FAIL: $1 (got '$2', want '$3')"; fail=1 ;; esac; }

echo '[{"name":"scale-build","state":"working","status":"busy","pid":1},{"name":"demo-heartbeat","state":"working","pid":2}]' >"$t/agents.json"
echo '[]' >"$t/prs.json"
echo '[]' >"$t/agents2.json"
echo '{"items":[{"id":"B-1","status":"in-progress"},{"id":"B-2","status":"done"}]}' >"$t/backlog.json"

check "first run notifies" "$(NEEDS_LEAD_NOW=1000 $N)" "NOTIFY first*"
check "nothing changed: quiet" "$(NEEDS_LEAD_NOW=1600 $N)" "QUIET"
# busy/idle flips and the heartbeat's own state are not changes.
echo '[{"name":"scale-build","state":"working","status":"idle","pid":1},{"name":"demo-heartbeat","state":"done","pid":null}]' >"$t/agents.json"
check "status flip and heartbeat ignored" "$(NEEDS_LEAD_NOW=2200 $N)" "QUIET"
echo '[{"name":"scale-build","state":"done","status":"idle","pid":null}]' >"$t/agents.json"
check "agent ended: notifies" "$(NEEDS_LEAD_NOW=2800 $N)" "NOTIFY*scale-build: working -> done (no process)*"
echo '[{"number":264}]' >"$t/prs.json"
check "new PR: notifies" "$(NEEDS_LEAD_NOW=3400 $N)" "NOTIFY*PR #264*"
check "then quiet again" "$(NEEDS_LEAD_NOW=4000 $N)" "QUIET"
check "quiet limit: notifies" "$(NEEDS_LEAD_NOW=$((3400 + 7200)) $N)" "NOTIFY no change for 120 min*"
echo '{"items":[{"id":"B-1","status":"done"},{"id":"B-2","status":"done"}]}' >"$t/backlog.json"
check "backlog change: notifies" "$(NEEDS_LEAD_NOW=11000 $N)" "NOTIFY*B-1: in-progress -> gone*"
# The agents' account has its own list; the lead shows in both without a state.
echo '[{"name":"lead","kind":"interactive","pid":3}]' >"$t/agents.json"
echo '[{"name":"lead","kind":"interactive","pid":3},{"name":"fx","kind":"background","state":"working","pid":4}]' >"$t/agents2.json"
check "agents account read" "$(NEEDS_LEAD_NOW=11600 $N)" "NOTIFY*agent fx: none -> working*"
echo '[{"name":"fx","kind":"background","state":"done"}]' >"$t/agents2.json"
check "agents account change" "$(NEEDS_LEAD_NOW=12200 $N)" "NOTIFY*fx: working -> done (no process)*"

# Stalls: an idle agent with nothing running, and a command running too long.
echo '[]' >"$t/agents2.json"
echo '[]' >"$t/agents.json"
NOW=200000
session() { echo "{\"pid\":$2,\"name\":\"$1\",\"kind\":\"background\",\"status\":\"$3\",\"statusUpdatedAt\":$(( ($NOW - $4 * 60) * 1000 ))}" >"$t/sessions/$2.json"; }
echo '  900     1  05:00 /usr/bin/caffeinate -i -t 300' >"$t/ps.txt"
NEEDS_LEAD_NOW=$NOW $N >/dev/null
session fx 900 idle 10
check "idle 10 min: quiet" "$(NEEDS_LEAD_NOW=$NOW $N)" "QUIET"
session fx 900 idle 25
check "idle 25 min: notifies" "$(NEEDS_LEAD_NOW=$NOW $N)" "NOTIFY fx idle 25 min, nothing running"
check "same episode: quiet" "$(NEEDS_LEAD_NOW=$((NOW + 600)) $N)" "QUIET"
session fx 900 idle 5
NEEDS_LEAD_NOW=$NOW $N >/dev/null
session fx 900 idle 30
check "new episode: notifies again" "$(NEEDS_LEAD_NOW=$NOW $N)" "NOTIFY fx idle 30 min*"
printf '%s\n' '  901   900  01:00 zsh -c make check' '  900     1  05:00 /usr/bin/caffeinate -i' >"$t/ps.txt"
session fx 900 idle 60
check "idle but a command runs: quiet" "$(NEEDS_LEAD_NOW=$NOW $N)" "QUIET"
printf '%s\n' '  901   900  2:40:00 zsh -c make check' >"$t/ps.txt"
check "command 160 min: notifies" "$(NEEDS_LEAD_NOW=$NOW $N)" "NOTIFY fx: one command running 160 min"
check "command episode: quiet" "$(NEEDS_LEAD_NOW=$NOW $N)" "QUIET"
printf '%s\n' '  903   900  1-01:00:00 zsh -c sleep 9' >"$t/ps.txt"
check "etime with days: new command" "$(NEEDS_LEAD_NOW=$NOW $N)" "NOTIFY fx: one command running 1500 min"
echo '[]' >"$t/ps.txt"; session demo-heartbeat 902 idle 90
session fx 900 busy 90
check "heartbeat and busy agents ignored" "$(NEEDS_LEAD_NOW=$NOW $N)" "QUIET"

# Usage thresholds: weekly 80 and 95, 5-hour 90; once per crossing per period; stale ignored.
echo '[]' >"$t/ps.txt"; rm -f "$t"/sessions/*
usage() { echo "{\"readAt\":$(( $4 * 1000 )),\"windows\":[{\"id\":\"five_hour\",\"label\":\"5 hours\",\"percentUsed\":$2,\"resetsAt\":$(( $5 * 1000 ))},{\"id\":\"seven_day\",\"label\":\"Week\",\"percentUsed\":$3,\"resetsAt\":$(( $6 * 1000 ))}]}" >"$t/usage/$1.json"; }
U=1800000000
export NEEDS_LEAD_MAX_QUIET_MIN=99999999
usage agents 10 50 $U $((U + 9000)) $((U + 400000))
check "below thresholds: quiet" "$(NEEDS_LEAD_NOW=$U $N)" "QUIET"
usage agents 10 82 $U $((U + 9000)) $((U + 400000))
check "weekly 82%: notifies" "$(NEEDS_LEAD_NOW=$U $N)" "NOTIFY usage agents Week 82%, resets *"
check "no repeat" "$(NEEDS_LEAD_NOW=$U $N)" "QUIET"
usage agents 10 96 $U $((U + 9000)) $((U + 400000))
check "weekly 96%: next level" "$(NEEDS_LEAD_NOW=$U $N)" "NOTIFY usage agents Week 96%*"
usage agents 91 96 $U $((U + 9000)) $((U + 400000))
check "5h 91% on top" "$(NEEDS_LEAD_NOW=$U $N)" "NOTIFY usage agents 5 hours 91%*"
usage agents 20 85 $((U + 1000)) $((U + 9000 + 18000)) $((U + 400000 + 604800))
check "new period re-arms" "$(NEEDS_LEAD_NOW=$((U + 1000)) $N)" "NOTIFY usage agents Week 85%*"
usage main 95 10 $U $((U + 9000)) $((U + 400000))
old=$((U - 3 * 3600))
usage agents 99 99 $old $((U + 9000)) $((U + 400000))
check "main 5h 95% notifies, stale agents ignored" "$(NEEDS_LEAD_NOW=$((U + 1000)) $N)" "NOTIFY usage main 5 hours 95%, resets *"
usage agents 99 99 $U $((U + 9000)) $((U + 400000))
check "fresh again: fires once" "$(NEEDS_LEAD_NOW=$((U + 1000)) $N)" "NOTIFY usage agents 5 hours 99%*Week 99%*"
check "then stale, then fresh again: no repeat" "$(usage agents 99 99 $old $((U + 9000)) $((U + 400000)); NEEDS_LEAD_NOW=$((U + 1000)) $N; usage agents 99 99 $U $((U + 9000)) $((U + 400000)); NEEDS_LEAD_NOW=$((U + 1000)) $N)" "QUIET*QUIET"

# Ready briefs per lane (lead_status.pipeline_alerts, min 2): a lane that goes
# low or empty wakes the lead once; while it stays low its line rides along on
# every other wake. blockedBy and dependsOn change nothing in the snapshot, so
# they move the count without any other change.
rm -f "$t/usage"/*.json
P="NEEDS_LEAD_NOW=$((U + 1000))"
bl() { printf '{"lanes":[{"id":"core"},{"id":"client"},{"id":"assets"},{"id":"flex"}],"items":[%s]}' "$1" >"$t/backlog.json"; }
C='{"id":"C1","status":"ready","lane":"core"},{"id":"C2","status":"ready","lane":"core","dependsOn":["C1"]}'
K='{"id":"K1","status":"ready","lane":"client"},{"id":"K2","status":"defined","lane":"client"}'
A='{"id":"A0","status":"review","lane":"assets"},{"id":"A1","status":"ready","lane":"assets","dependsOn":["A0"]}'
F='{"id":"F1","status":"ready","lane":"flex"}'
bl "$C,$K,$A,$F"
out=$(env $P $N)
check "low and empty lanes wake the lead" "$out" "NOTIFY*pipeline empty: assets 0 ready, nothing defined to brief: tell the owner*briefs low: client 1 ready (min 2), 1 defined to brief*"
check "a full lane is not named" "$(echo "$out" | grep -c 'core')" 0
check "unchanged: quiet" "$(env $P $N)" "QUIET"
echo '[{"number":500}]' >"$t/prs.json"
check "another wake carries the low lanes" "$(env $P $N)" "NOTIFY*PR #500: none -> open; pipeline empty: assets*briefs low: client*"
bl "$(echo "$C" | sed 's/"lane":"core","dependsOn"/"lane":"core","blockedBy":"Sam","dependsOn"/'),$K,$A,$F"
check "a lane going low alone wakes it" "$(env $P $N)" "NOTIFY pipeline empty: core 1 ready*"
check "and only once" "$(env $P $N)" "QUIET"
bl "$(echo "$C" | sed 's/"lane":"core","dependsOn"/"lane":"core","blockedBy":"Sam","dependsOn"/'),$(echo "$K" | sed 's/"defined","lane":"client"/"defined","lane":"client","blockedBy":"Sam"/'),$A,$F"
check "a low lane turning empty wakes it" "$(env $P $N)" "NOTIFY pipeline empty: client 1 ready*"
bl "$C"',{"id":"K1","status":"ready","lane":"client"},{"id":"K2","status":"ready","lane":"client"},{"id":"A1","status":"ready","lane":"assets"},{"id":"A2","status":"ready","lane":"assets"}'
echo '[]' >"$t/prs.json"
out=$(env $P $N)
check "refilled: the wake names no lane" "$(echo "$out" | grep -c 'briefs low\|pipeline empty')" 0
bl '{"id":"A1","status":"ready","lane":"assets"},{"id":"A2","status":"ready","lane":"assets"},{"id":"K1","status":"ready","lane":"client"},{"id":"K2","status":"ready","lane":"client"}'
check "a lane low again wakes it again" "$(env $P $N)" "NOTIFY*pipeline empty: core 0 ready*"
echo '{"items":[{"id":"X","status":"ready"}]}' >"$t/backlog.json"
check "no lanes in the backlog: not counted" "$(env $P $N | grep -c 'briefs low\|pipeline empty')" 0

# --- the main check (safety net, suite cache): started when main moved and
# the check queue is empty, a red run wakes the lead once ---
rm -f "$t/usage"/*.json
M=$t/main; mkdir -p "$M/locks/locks/check.queue"
printf '#!/bin/sh\necho started >> %s/started\n' "$M" >"$M/cmd"; chmod +x "$M/cmd"
export NEEDS_LEAD_MAIN_CMD=$M/cmd NEEDS_LEAD_CHECKS=$M/checks.jsonl NEEDS_LEAD_LOCKS=$M/locks NEEDS_LEAD_MAIN_PID=$M/pid
# The command starts detached: give it up to 5 s (a loaded machine) to write.
started() { for _ in $(seq 50); do [ -f "$M/started" ] && break; sleep 0.1; done; [ -f "$M/started" ] && wc -l <"$M/started" | tr -d " " || echo 0; }
echo '{"branch":"main","commit":"aaaa1111","result":"green"}' >"$M/checks.jsonl"
NEEDS_LEAD_MAIN_SHA=aaaa1111ffff $N >/dev/null
check "main not moved: not started" "$(started)" 0
touch "$M/locks/locks/check.lock"
NEEDS_LEAD_MAIN_SHA=bbbb2222ffff $N >/dev/null
check "main moved, check lock held: not started" "$(started)" 0
rm "$M/locks/locks/check.lock"; touch "$M/locks/locks/check.queue/1-1"
NEEDS_LEAD_MAIN_SHA=bbbb2222ffff $N >/dev/null
check "main moved, a ticket waits: not started" "$(started)" 0
rm "$M/locks/locks/check.queue/1-1"; echo $$ >"$M/pid"
NEEDS_LEAD_MAIN_SHA=bbbb2222ffff $N >/dev/null
check "main moved, a main run alive: not started" "$(started)" 0
rm "$M/pid"
check "main moved, queue empty: started, no wake" "$(NEEDS_LEAD_MAIN_SHA=bbbb2222ffff $N; started)" "QUIET*1"
echo '{"branch":"feature","commit":"bbbb2222","result":"failed"}' >>"$M/checks.jsonl"
echo '{"branch":"main","commit":"bbbb2222","result":"failed","part":"check"}' >>"$M/checks.jsonl"
check "red main run wakes the lead" "$(NEEDS_LEAD_MAIN_SHA=bbbb2222ffff $N)" "NOTIFY main check red at bbbb2222 (check part)*"
check "red main run wakes it once" "$(NEEDS_LEAD_MAIN_SHA=bbbb2222ffff $N)" "QUIET"
check "red run not restarted on the same commit" "$(started)" 1
exit $fail
