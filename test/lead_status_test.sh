#!/bin/bash
# lead_status.py with the second account and with lanes: both accounts' agents
# are listed with the command for each, unnamed sessions survive, the lanes line
# shows caps, OVER, next items and ready counts, and the backlog groups by lane.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
repo=$(make_repo)
bin=$(mktemp -d)
trap 'rm -rf "$repo" "$bin"' EXIT
python3 "$INIT" --repo "$repo" --owner Sam --slug demo --agents-account --lanes core:1,client:1,assets:1,flex:1 >/dev/null || { echo "FAIL: init"; exit 1; }
T="$repo/tools/ops-kit"

# The fake claude answers per account: the agents' account sets CLAUDE_CONFIG_DIR.
cat >"$bin/claude" <<EOF
#!/bin/sh
if [ -n "\$CLAUDE_CONFIG_DIR" ]; then
  echo '[{"kind":"background","name":"fx-agent","id":"fx1","status":"idle","state":"done","cwd":"$repo"}]'
else
  echo '[{"kind":"background","id":"abc123","status":"busy","state":"working","cwd":"$repo"},{"kind":"background","name":null,"id":"def456","status":"idle","state":"done","cwd":"$repo"},{"kind":"background","name":"demo-heartbeat","id":"hb1","status":"idle","state":"idle","cwd":"$repo"}]'
fi
EOF
chmod +x "$bin/claude"
printf '#!/bin/sh\nexit 0\n' >"$bin/gh"
chmod +x "$bin/gh"
mkdir -p "$bin/main/sessions" "$bin/agents"
ln -s "$bin/main/sessions" "$bin/agents/sessions"
export OPS_AGENTS_CONFIG=$bin/agents OPS_MAIN_CONFIG=$bin/main OPS_CLAUDE_BIN=$bin/claude
run() { (cd "$repo" && PATH="$bin:$PATH" CLAUDE_CONFIG_DIR=$bin/agents python3 "$T/lead_status.py" 2>&1); }

# CLAUDE_CONFIG_DIR set as in an agent's shell: the main list must ignore it.
cat >"$repo/tmp/ops/status.json" <<'EOF'
{"schema":1,"agentLimit":4,"agents":[
 {"name":"ui-a","kind":"inproc","lane":"client"},
 {"name":"ui-b","kind":"inproc","lane":"client"},
 {"name":"painter","kind":"inproc"}],"signoff":[]}
EOF
cat >"$repo/tmp/ops/backlog.json" <<'EOF'
{"schema":1,"items":[
 {"id":"B-1","title":"core one","status":"ready","rank":1,"lane":"core"},
 {"id":"B-2","title":"assets running","status":"in_progress","rank":2,"lane":"assets","agent":"painter"},
 {"id":"B-3","title":"assets ready","status":"ready","rank":3,"lane":"assets"},
 {"id":"B-4","title":"flex waits","status":"ready","rank":4,"lane":"flex","dependsOn":["B-9"]},
 {"id":"B-6","title":"core two","status":"ready","rank":6,"lane":"core"},
 {"id":"B-5","title":"moon item","status":"ready","rank":5,"lane":"moon","dependsOn":["B-9"]}]}
EOF
out=$(run)
code=$?
check "lead_status exit" "$code" 0
for want in "abc123 busy/working main account" def456 demo-heartbeat "fx-agent fx1 idle/done agents account"; do
  contains "both accounts: $want" "$out" "$want"
done

# Lanes: client is over its cap; assets holds an in-progress item that names its agent
# (no lane in status.json); flex's only ready item waits for a dependency, so flex has no next.
for want in "lanes: core 0/1 (next B-1)" "client 2/1 OVER" "assets 1/1 (next B-3)" "flex 0/1" \
  "CORE (2 open, next B-1)" "B-6 [ready]" "FLEX (2 open)" "unknown lane 'moon'"; do
  contains "lanes: $want" "$out" "$want"
done

# Ready briefs per lane (minReady 2; flex keeps none): a ready item behind a ready one
# counts, one behind an item in review or with blockedBy does not.
cat >"$repo/tmp/ops/backlog.json" <<'EOF'
{"schema":1,"items":[
 {"id":"B-1","status":"ready","rank":1,"lane":"core"},
 {"id":"B-2","status":"ready","rank":2,"lane":"core","dependsOn":["B-1"]},
 {"id":"B-3","status":"ready","rank":3,"lane":"client","dependsOn":["B-4"]},
 {"id":"B-4","status":"review","rank":4,"lane":"client"},
 {"id":"B-5","status":"ready","rank":5,"lane":"assets","blockedBy":"Sam"}]}
EOF
out=$(run)
for want in "core 0/1 (next B-1) 2 ready," "client 2/1 OVER 0 ready LOW" "(next B-5) 0 ready LOW"; do
  contains "ready count: $want" "$out" "$want"
done
case "$out" in *"flex 0/1 "*"ready"*) echo "FAIL: flex keeps no briefs but shows a ready count"; fail=1 ;; *) echo "ok: flex shows no ready count" ;; esac

# Without lanes there is no lanes line and the backlog stays one list.
python3 - "$repo/.claude/ops-kit.json" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["lanes"] = []
json.dump(c, open(p, "w"))
EOF
out=$(run)
case "$out" in *"lanes:"*) echo "FAIL: lanes line without lanes"; fail=1 ;; *) echo "ok: no lanes, no lanes line" ;; esac
contains "no lanes: the backlog lists" "$out" "B-1 [ready"

# Without the second account only the main list is read.
python3 - "$repo/.claude/ops-kit.json" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["agentsAccount"] = False
json.dump(c, open(p, "w"))
EOF
out=$(run)
case "$out" in *fx-agent*) echo "FAIL: the agents' account read although it is off"; fail=1 ;; *) echo "ok: one account when agentsAccount is off" ;; esac
exit $fail
