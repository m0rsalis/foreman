#!/bin/bash
# The full check and its suite cache, on a scratch repo with the tools installed:
# the FULLCHECK line names the commit; a step with a `cache` is skipped on the
# same inputs (and joins no queue); excluded paths do not change the inputs, kept
# ones do; the toolchain always does; a dirty tree or a forced run records
# nothing wrong; failures are never cached; the main check runs forced in its own
# worktree. Takes about half a minute.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
unset FORCE_ALL FORCE_LINUX FULLCHECK_BRANCH
repo=$(make_repo)
fa=$(mktemp -d)
trap 'rm -rf "$repo" "$fa"' EXIT
python3 "$INIT" --repo "$repo" --owner Test --slug demo >/dev/null || { echo "FAIL: init"; exit 1; }
gitc() { git -C "$repo" -c user.email=t@t -c user.name=t "$@"; }
mkdir -p "$repo/docs" "$repo/assets" "$repo/src"
echo a >"$repo/docs/a.md"
echo a >"$repo/assets/keep.txt"
echo a >"$repo/assets/other.txt"
echo a >"$repo/src/code.txt"
echo a >"$repo/tracked.txt"

# Three cached steps and one that always runs; each appends its part to $FA_MADE.
setup_config() {
  python3 - "$repo/.claude/foreman.json" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c.pop("checkCommand", None)
c["fullCheck"] = [
    {"part": "lint", "lock": None, "command": 'echo lint >>"$FA_MADE"', "cache": {"exclude": ["docs"]}},
    {"part": "unit", "lock": "check", "command": 'echo unit >>"$FA_MADE"',
     "cache": {"exclude": ["docs", "assets"], "keep": ["assets/keep.txt"]}},
    {"part": "act", "lock": None,
     "command": 'echo act >>"$FA_MADE"; case "${FA_ACTION:-}" in commit) git commit -q --allow-empty -m during ;; edit) echo more >>tracked.txt ;; esac'},
]
json.dump(c, open(p, "w"), indent=2)
EOF
}
setup_config
gitc add -A
gitc commit -qm "kit and fixtures"
export FA_MADE="$fa/made" OPS_CHECKS_LOG="$fa/checks.jsonl" OPS_STEPS_LOG="$fa/steps.jsonl" SUITE_CACHE_DIR="$fa/cache" OPS_AGENT_LOCKS="$fa/locks"
FC="$repo/tools/foreman/fullcheck.sh"
fc() { (cd "$repo" && "$FC" >"$fa/out" 2>&1); code=$?; tail -1 "$fa/out"; return $code; }
made() { if [ -f "$FA_MADE" ]; then tr '\n' ' ' <"$FA_MADE"; fi; }
sha() { gitc rev-parse --short HEAD; }
commit() { gitc add -A && gitc commit -qm "$1"; }

# The first run runs everything; the same commit again runs only the uncacheable step.
s=$(sha)
out=$(fc); code=$?
check "first run: line names the commit" "$out" "FULLCHECK: all green at $s (0 of 3 steps cached)"
check "first run: exit code" "$code" 0
check "first run: every step ran" "$(made)" "lint unit act "
rm -f "$FA_MADE"
out=$(fc)
check "same commit: only the step without a cache ran" "$out $(made)" "FULLCHECK: all green at $s (2 of 3 steps cached) act "
contains "cached steps are named" "$(cat "$fa/out")" "STEP lint cached"
check "checks.jsonl has commit, clean and cached" "$(tail -1 "$fa/checks.jsonl" | grep -c "\"commit\":\"$s\",\"clean\":true.*\"cached\":2")" 1
check "steps.jsonl lists the cached steps" "$(tail -1 "$fa/steps.jsonl" | grep -c '"cached":\["lint","unit"\]')" 1

# A cached step joins no queue: with the check lock held, a fully cached run still finishes.
"$repo/tools/foreman/queue.sh" check sleep 25 >/dev/null 2>&1 &
holder=$!
sleep 2
(cd "$repo" && "$FC" >"$fa/held" 2>&1) &
runner=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$runner" 2>/dev/null || break; sleep 1; done
check "cached step did not wait for the lock" "$(kill -0 "$runner" 2>/dev/null && echo waiting || echo finished)" finished
kill "$runner" 2>/dev/null
kill "$holder" 2>/dev/null
wait 2>/dev/null
rm -rf "$fa/locks"

# Excluded paths do not change a step's inputs; a path nobody excluded does.
rm -f "$FA_MADE"
echo b >>"$repo/docs/a.md"; commit docs
out=$(fc)
check "docs change: lint and unit stay cached" "$out $(made)" "FULLCHECK: all green at $(sha) (2 of 3 steps cached) act "
rm -f "$FA_MADE"
echo b >>"$repo/assets/other.txt"; commit assets-other
out=$(fc)
check "assets change: lint reruns, unit stays cached" "$out $(made)" "FULLCHECK: all green at $(sha) (1 of 3 steps cached) lint act "
rm -f "$FA_MADE"
echo b >>"$repo/assets/keep.txt"; commit assets-keep
out=$(fc)
check "a kept path inside an excluded folder reruns the step" "$out $(made)" "FULLCHECK: all green at $(sha) (0 of 3 steps cached) lint unit act "
rm -f "$FA_MADE"
echo b >>"$repo/src/code.txt"; commit src
out=$(fc)
check "a source change reruns every cached step" "$out $(made)" "FULLCHECK: all green at $(sha) (0 of 3 steps cached) lint unit act "

# The toolchain (the tools folder) is an input of every step, whatever the exclusions say.
rm -f "$FA_MADE"
echo "# edited" >>"$repo/tools/foreman/README.md"; commit toolchain
out=$(fc)
check "a tools change reruns every step" "$out $(made)" "FULLCHECK: all green at $(sha) (0 of 3 steps cached) lint unit act "
out=$(fc)
check "then the steps are cached again" "$out" "FULLCHECK: all green at $(sha) (2 of 3 steps cached)"

# A dirty tree uses no cache and records nothing.
rm -f "$FA_MADE"
echo b >>"$repo/src/code.txt"; commit src2
echo dirty >>"$repo/tracked.txt"
out=$(fc)
check "dirty tree: line says so, nothing cached" "$out $(made)" "FULLCHECK: all green at $(sha) + uncommitted changes (0 of 3 steps cached) lint unit act "
gitc checkout -q tracked.txt
rm -f "$FA_MADE"
out=$(fc)
check "dirty run recorded nothing: the clean run reruns" "$out $(made)" "FULLCHECK: all green at $(sha) (0 of 3 steps cached) lint unit act "

# FORCE_ALL=1 runs every step on a cached commit, and still records.
rm -f "$FA_MADE"
out=$(FORCE_ALL=1 fc)
check "FORCE_ALL runs every step" "$out $(made)" "FULLCHECK: all green at $(sha) (0 of 3 steps cached) lint unit act "
out=$(fc)
check "after FORCE_ALL the steps are cached" "$out" "FULLCHECK: all green at $(sha) (2 of 3 steps cached)"

# A failing step is reported by its part and never cached.
python3 - "$repo/.claude/foreman.json" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["fullCheck"].insert(1, {"part": "flaky", "lock": None, "command": '[ "${FA_FAIL:-}" != 1 ]', "cache": {}})
json.dump(c, open(p, "w"), indent=2)
EOF
commit flaky
out=$(FA_FAIL=1 fc); code=$?
check "failure: the line names the part" "$out" "FULLCHECK: flaky FAILED"
check "failure: exit code" "$([ "$code" -ne 0 ] && echo nonzero || echo zero)" nonzero
check "failure: checks.jsonl says failed" "$(tail -1 "$fa/checks.jsonl" | grep -c '"result":"failed","part":"flaky"')" 1
out=$(fc)
check "a failed step was not cached: it reruns and passes" "$out" "FULLCHECK: all green at $(sha) (1 of 4 steps cached)"

# HEAD or the tree moving during the run is reported, not called green.
now0=$(sha)
out=$(FORCE_ALL=1 FA_ACTION=commit fc); code=$?
check "HEAD moved: line" "$out" "FULLCHECK: all green at $now0, but HEAD is now $(sha): rerun before merging"
check "HEAD moved: exit code" "$([ "$code" -ne 0 ] && echo nonzero || echo zero)" nonzero
now0=$(sha)
out=$(FORCE_ALL=1 FA_ACTION=edit fc); code=$?
case "$out" in "FULLCHECK: all green at $now0, but the working tree changed"*) r=yes ;; *) r="no ($out)" ;; esac
check "tree changed: line" "$r" yes
check "tree changed: exit code" "$([ "$code" -ne 0 ] && echo nonzero || echo zero)" nonzero
gitc checkout -q tracked.txt

# A step that says it ran nothing real (a gated step) is not recorded.
python3 - "$repo/.claude/foreman.json" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["fullCheck"] = [{"part": "gated", "lock": None, "command": 'echo gated >>"$FA_MADE"; echo "foreman: no-cache"', "cache": {}}]
json.dump(c, open(p, "w"), indent=2)
EOF
commit gated
rm -f "$FA_MADE"
fc >/dev/null; fc >/dev/null
check "no-cache marker: the step ran both times" "$(made)" "gated gated "

# checkCommand alone is never cached.
python3 - "$repo/.claude/foreman.json" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c.pop("fullCheck")
c["checkCommand"] = 'echo cmd >>"$FA_MADE"'
json.dump(c, open(p, "w"), indent=2)
EOF
commit checkcommand
rm -f "$FA_MADE"
fc >/dev/null
out=$(fc)
check "checkCommand: never cached" "$out $(made)" "FULLCHECK: all green at $(sha) (0 of 1 steps cached) cmd cmd "

# suite_cache.py lint: every excluded path must exist at HEAD.
setup_config
commit config
check "lint: real paths pass" "$(cd "$repo" && python3 tools/foreman/suite_cache.py lint; echo "exit=$?")" "exit=0"
python3 - "$repo/.claude/foreman.json" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["fullCheck"][0]["cache"]["exclude"].append("no/such/path")
json.dump(c, open(p, "w"), indent=2)
EOF
out=$(cd "$repo" && python3 tools/foreman/suite_cache.py lint; echo "exit=$?")
contains "lint: a missing path is reported" "$out" "no such path at HEAD: lint: no/such/path"
contains "lint: and fails" "$out" "exit=1"
setup_config

# main_fullcheck.sh: a forced check of origin/main in its own detached worktree.
commit before-main-check
git clone -q --bare "$repo" "$fa/origin.git"
gitc remote add origin "$fa/origin.git"
gitc fetch -q origin
export MAIN_CHECK_WORKTREE="$fa/mc"
mc() { (cd "$repo" && tools/foreman/main_fullcheck.sh) 2>&1 | tail -1; }
rm -f "$FA_MADE"
out=$(fc)
msha=$(git -C "$repo" rev-parse --short origin/main)
rm -f "$FA_MADE"
out=$(mc)
check "main check: green line, nothing cached (forced)" "$out" "FULLCHECK: all green at $msha (0 of 3 steps cached)"
check "main check: every step ran" "$(made)" "lint unit act "
check "main check: log under tmp/logs" "$(tail -1 "$repo/tmp/logs/main-check.log")" "FULLCHECK: all green at $msha (0 of 3 steps cached)"
check "main check: checks.jsonl names the main branch" "$(tail -1 "$fa/checks.jsonl" | grep -c '"branch":"main"')" 1
check "main check: its worktree is detached" "$(git -C "$fa/mc" rev-parse --abbrev-ref HEAD)" HEAD
echo "$$" >"$repo/tmp/ops/main-check.pid"
contains "main check: one run at a time" "$(mc)" "already running"
rm -f "$repo/tmp/ops/main-check.pid"
exit $fail
