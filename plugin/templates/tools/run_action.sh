#!/bin/bash
# Runs the Ops panel's action (the `action` in .claude/ops-kit.json: a
# deploy, a release build, a report) and keeps its state for the panel.
#   run_action.sh [--detach] <command>
# The command runs with /bin/bash -c in the main checkout, its output in
# tmp/ops/action.log, its state in tmp/ops/action.json (running, ok, failed,
# with pid, times and exit code). --detach starts it in the background and
# returns at once, so it outlives the session that pressed the button. A
# second run is refused while one is running.
set -u
here=$(cd "$(dirname "$0")" && pwd)
main=$(python3 -I "$here/ops_config.py" main) || exit 2
ops="$main/tmp/ops"
mkdir -p "$ops"
state="$ops/action.json"
log="$ops/action.log"
detach=0
if [ "${1:-}" = "--detach" ]; then detach=1; shift; fi
cmd=${1:?usage: run_action.sh [--detach] <command>}

pid=$(python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print(d.get("pid","") if d.get("state")=="running" else "")' "$state")
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  echo "run_action: already running (pid $pid)" >&2
  exit 1
fi

if [ "$detach" = 1 ]; then
  nohup /bin/bash "$here/run_action.sh" "$cmd" >/dev/null 2>&1 </dev/null &
  echo "run_action: running in the background (pid $!), log tmp/ops/action.log"
  exit 0
fi

write_state() { # state, exit code or empty
  python3 - "$state" "$1" "$$" "${2:-}" "$started" <<'EOF'
import json, os, sys, time
path, st, pid, code, started = sys.argv[1:6]
d = {"state": st, "pid": int(pid), "startedAt": started}
if code:
    d["exitCode"] = int(code)
    d["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f)
    f.write("\n")
os.replace(tmp, path)
EOF
}
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
write_state running
{ echo "== $started: $cmd"; } >"$log"
(cd "$main" && /bin/bash -c "$cmd") >>"$log" 2>&1
code=$?
echo "== exit $code" >>"$log"
if [ "$code" -eq 0 ]; then write_state ok "$code"; else write_state failed "$code"; fi
exit "$code"
