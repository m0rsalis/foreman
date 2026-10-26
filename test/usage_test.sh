#!/bin/bash
# Tests for statusline.py, usage_write.py and usage_show.py as the init installs
# them: the right account's file, the printed line, survival of odd input, and
# the main checkout's folder found from a worktree.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
repo=$(make_repo)
t=$(mktemp -d)
trap 'rm -rf "$repo" "$t"' EXIT
python3 "$INIT" --repo "$repo" --owner Sam --slug demo >/dev/null || { echo "FAIL: init"; exit 1; }
T="$repo/tools/ops-kit"
export OPS_DIR=$t
S="python3 $T/statusline.py"
W="python3 $T/usage_write.py"
# shellcheck disable=SC2254  # the expected value is a glob on purpose
glob() { case "$2" in $3) echo "ok: $1" ;; *) echo "FAIL: $1 (got '$2', want '$3')"; fail=1 ;; esac; }
field() { python3 -c "import json,sys; d=json.load(open('$1')); print($2)"; }

in='{"rate_limits":{"five_hour":{"used_percentage":41,"resets_at":1792250000},"seven_day":{"used_percentage":12.5,"resets_at":1792700000}}}'
out=$(echo "$in" | CLAUDE_CONFIG_DIR=$HOME/.claude-agents $S)
glob "agents line" "$out" "agents: 5h 41% wk 12% resets *"
check "agents file written" "$(field "$t/usage/agents.json" "d['account'], d['windows'][0]['percentUsed'], d['windows'][1]['resetsAt']")" "agents 41.0 1792700000000"
# shellcheck disable=SC2010  # names are our own, plain ASCII
check "main file not written for agents" "$(ls "$t/usage" | grep -c '^main.json$')" "0"
echo "$in" | env -u CLAUDE_CONFIG_DIR $S >/dev/null
check "unset config dir is main" "$(field "$t/usage/main.json" "d['account']")" "main"
check "raw input kept" "$(grep -c rate_limits "$t/usage/main.input.json")" "1"

before=$(cksum <"$t/usage/main.json")
out=$(echo '{"model":"x"}' | env -u CLAUDE_CONFIG_DIR $S)
check "no rate_limits: line" "$out" "main: no usage yet"
check "no rate_limits: file kept" "$(cksum <"$t/usage/main.json")" "$before"
check "garbage input survives" "$(echo 'not json' | env -u CLAUDE_CONFIG_DIR $S)" "main: usage unreadable"
check "empty input survives" "$(printf '' | env -u CLAUDE_CONFIG_DIR $S)" "main: no usage yet"

app='{"plan":{"plan":"Team","windows":[{"label":"5 hour","percentUsed":70,"resetsAt":"2026-10-17T18:00:00Z"},{"label":"Weekly","percentUsed":150,"resetsAt":1792700000000},{"label":"bad"}]}}'
check "writer" "$(echo "$app" | $W main)" "written"
check "writer fields" "$(field "$t/usage/main.json" "d['plan'], len(d['windows']), d['windows'][0]['resetsAt'], d['windows'][1]['percentUsed'], d['windows'][1]['resetsAt']")" "Team 2 1792260000000 100.0 1792700000000"
echo '{"plan":{"windows":[]}}' | $W main >/dev/null
check "writer with nothing exits 1" "$?" "1"
$W bogus </dev/null 2>/dev/null
check "writer rejects unknown account" "$?" "1"

# usage_show.py: both accounts, a hand-written main file, stale, a missing account.
SH="python3 $T/usage_show.py"
rm -f "$t"/usage/*
N0=1800000000
echo "{\"readAt\":$(( (N0 - 120) * 1000 )),\"windows\":[{\"id\":\"five_hour\",\"label\":\"5 hours\",\"percentUsed\":41,\"resetsAt\":$(( (N0 + 9000) * 1000 ))}]}" >"$t/usage/agents.json"
echo '{"account":"main","updatedAt":"2027-01-15T07:20:00Z","windows":[{"label":"Weekly","percentUsed":83,"resetsAt":"2027-01-19T02:00:00Z"}]}' >"$t/usage/main.json"
out=$(USAGE_SHOW_NOW=$N0 $SH)
glob "show: agents row" "$out" "*agents *5 hours *41% *(in 2h 30m) *2m old*"
glob "show: hand-written main row, stale" "$out" "*main *Weekly *83% *(in * 40m old (stale)*"
rm "$t/usage/main.json"
glob "show: missing account" "$(USAGE_SHOW_NOW=$N0 $SH | grep '^main')" "main*no reading"

# Without OPS_DIR a worktree's copy writes into the main checkout's tmp/ops.
unset OPS_DIR
git -C "$repo" add -A >/dev/null 2>&1
git -C "$repo" commit -q -m tools
git -C "$repo" worktree add -q "$repo/.claude/worktrees/w1" -b w1
echo "$in" | CLAUDE_CONFIG_DIR=$HOME/.claude-agents python3 "$repo/.claude/worktrees/w1/tools/ops-kit/statusline.py" >/dev/null
check "a worktree writes into the main checkout" "$(field "$repo/tmp/ops/usage/agents.json" "d['account']")" "agents"
check "nothing written inside the worktree" "$(ls "$repo/.claude/worktrees/w1/tmp" 2>/dev/null | wc -l | tr -d ' ')" "0"
exit $fail
