#!/bin/bash
# Tests for lead_status.py and run_action.sh as the init installs them.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
repo=$(make_repo)
bin=$(mktemp -d)
trap 'rm -rf "$repo" "$bin"' EXIT
python3 "$INIT" --repo "$repo" --owner Sam --slug demo >/dev/null || { echo "FAIL: init"; exit 1; }
T="$repo/tools/ops-kit"

# lead_status.py: a fake `claude agents` with sessions of this repo, another repo, and unnamed ones.
cat >"$bin/claude" <<EOF
#!/bin/sh
echo '[{"kind":"background","id":"abc123","status":"busy","state":"working","cwd":"$repo/.claude/worktrees/api"},{"kind":"background","name":null,"id":"def456","status":"idle","state":"done","cwd":"$repo"},{"kind":"background","name":"demo-heartbeat","id":"hb1","status":"idle","state":"idle","cwd":"$repo"},{"kind":"background","name":"stranger","id":"zzz999","status":"busy","state":"working","cwd":"/elsewhere"},{"kind":"background","name":"gone-agent","id":"g1","sessionId":"11111111-2222-3333-4444-555555555555","status":"idle","state":"done","cwd":"$repo/.claude/worktrees/gone"}]'
EOF
chmod +x "$bin/claude"
cat >"$repo/tmp/ops/status.json" <<'EOF'
{"schema":1,"agentLimit":2,"priority":"Importer first","agents":[{"name":"gone-agent","kind":"bg","sessionName":"gone-agent","model":"opus","worktree":".claude/worktrees/gone","branch":"gone","step":"tests"}],"signoff":[{"item":"Try it","kind":"test"}]}
EOF
cat >"$repo/tmp/ops/backlog.json" <<'EOF'
{"schema":1,"items":[{"id":"B-1","title":"Importer","status":"in-progress","rank":1,"agent":"gone-agent"},{"id":"B-2","title":"Export","status":"ready","rank":2,"dependsOn":["B-1"]},{"id":"B-3","title":"Docs","status":"ready","rank":3,"brief":"tmp/ops/briefs/docs.md"},{"id":"B-0","title":"Old","status":"done"}]}
EOF
out=$(cd "$repo" && PATH="$bin:$PATH" python3 "$T/lead_status.py" 2>&1)
check "lead_status exit" "$?" 0
for want in abc123 def456 "agent cap 2; owner Sam" "priority: Importer first" "AGENTS (1 of 2)" \
  "revive: claude --bg --resume 11111111-2222-3333-4444-555555555555" "B-3 [ready NEXT]" "waits B-1" "B-1 [in_progress gone-agent]" \
  "1 done" "check: free" "WAITING FOR SAM" "[test] Try it"; do
  contains "lead_status shows $want" "$out" "$want"
done
case "$out" in *stranger*|*zzz999*) echo "FAIL: another repo's session listed"; fail=1 ;; *) echo "ok: other repos' sessions left out" ;; esac
case "$out" in *"is not running"*) echo "FAIL: heartbeat reported missing"; fail=1 ;; *) echo "ok: heartbeat found by its configured name" ;; esac

# run_action.sh: foreground, detached, refused while running, failure recorded.
state() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["state"], d.get("exitCode"))' "$repo/tmp/ops/action.json"; }
(cd "$repo" && "$T/run_action.sh" 'echo built; pwd' >/dev/null)
check "action ok" "$(state)" "ok 0"
contains "action log" "$(cat "$repo/tmp/ops/action.log")" "built"
contains "action runs in the main checkout" "$(cat "$repo/tmp/ops/action.log")" "$repo"
(cd "$repo" && "$T/run_action.sh" 'exit 4' >/dev/null)
check "action failure exit" "$?" 4
check "action failed state" "$(state)" "failed 4"
out=$(cd "$repo" && "$T/run_action.sh" --detach 'sleep 3; echo late')
contains "detach returns at once" "$out" "running in the background"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(state)" = "running None" ] && break; sleep 0.3; done
check "detached run is running" "$(state)" "running None"
out=$(cd "$repo" && "$T/run_action.sh" 'echo second' 2>&1)
check "second run refused" "$?" 1
contains "refusal says why" "$out" "already running"
for _ in $(seq 1 30); do [ "$(state)" = "ok 0" ] && break; sleep 0.3; done
check "detached run finished" "$(state)" "ok 0"
contains "detached log" "$(cat "$repo/tmp/ops/action.log")" "late"

exit $fail
