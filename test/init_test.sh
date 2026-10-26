#!/bin/bash
# Tests for the init (plugin/scripts/ops_init.py) on scratch repos: every file
# it writes, idempotence, edited files kept, upgrades, forced overwrites,
# worktrees, a dry run. Takes a few seconds.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
repo=$(make_repo)
trap 'rm -rf "$repo" "$repo-wt" "${dry:-}"' EXIT
init() { python3 "$INIT" --repo "$repo" "$@"; }
# Every file outside .git with its hash, mode and mtime: two equal snapshots mean nothing was touched.
snapshot() {
  (cd "$1" && find . -path ./.git -prune -o -type f -print | sort | while read -r f; do
    printf '%s %s %s\n' "$f" "$(shasum -a 256 "$f" | cut -c1-16)" "$(stat -f '%p %m' "$f")"
  done)
}

# Existing project files the init must keep.
printf '# Demo\n\nOur own rules.\n' >"$repo/CLAUDE.md"
mkdir -p "$repo/.claude"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]},"permissions":{"allow":["Bash(make:*)"]}}\n' >"$repo/.claude/settings.local.json"

# 1. First run: every file, with the values given.
out=$(init --owner Sam --lead demo-lead --slug demo --cap 3 --locks check:90,sim:45)
contains "first run summary" "$out" "INIT: 30 created, 2 updated, 0 unchanged, 0 kept"
for f in .claude/ops-kit.json .claude/ops-kit-files.json .claude/agents/demo-engineer.md .claude/agents/demo-implementer.md \
  .claude/agents/demo-checker.md tools/ops-kit/queue.sh tools/ops-kit/queue_lock.py tools/ops-kit/queue_run.py \
  tools/ops-kit/fullcheck.sh tools/ops-kit/run_action.sh tools/ops-kit/lead_status.py tools/ops-kit/ops_config.py \
  tools/ops-kit/README.md tools/ops-kit/heartbeat.md tmp/ops/status.json tmp/ops/backlog.json tmp/ops/lead-notes.md .gitignore; do
  check "wrote $f" "$([ -s "$repo/$f" ] && echo yes)" yes
done
for d in tmp/ops/briefs tmp/ops/reports; do check "made $d/" "$([ -d "$repo/$d" ] && echo yes)" yes; done
for f in queue.sh fullcheck.sh run_action.sh lead_status.py ops_config.py queue_lock.py queue_run.py; do
  check "$f is executable" "$([ -x "$repo/tools/ops-kit/$f" ] && echo yes)" yes
done
check "no placeholder left" "$(grep -rl '{{' "$repo/.claude" "$repo/tools" "$repo/CLAUDE.md" "$repo/tmp" | wc -l | tr -d ' ')" 0
check "engineer is opus" "$(grep -c '^model: opus$' "$repo/.claude/agents/demo-engineer.md")" 1
check "implementer is sonnet" "$(grep -c '^model: sonnet$' "$repo/.claude/agents/demo-implementer.md")" 1
check "checker is haiku" "$(grep -c '^model: haiku$' "$repo/.claude/agents/demo-checker.md")" 1
check "agent names carry the slug" "$(grep -h '^name:' "$repo"/.claude/agents/demo-*.md | tr '\n' ' ')" "name: demo-checker name: demo-engineer name: demo-implementer "
md=$(cat "$repo/CLAUDE.md")
contains "CLAUDE.md keeps its own text" "$md" "Our own rules."
contains "CLAUDE.md has the section" "$md" "<!-- ops-kit:begin"
contains "CLAUDE.md names the owner" "$md" "These rules are Sam's"
contains "CLAUDE.md names the lead" "$md" "The lead's session name is \`demo-lead\`"
contains "CLAUDE.md names the locks" "$md" "declared locks: \`check\`, \`sim\`"
contains "CLAUDE.md names the check" "$md" "full check (\`make check\`)"
contains "heartbeat command names the lead" "$(cat "$repo/tools/ops-kit/heartbeat.md")" "--name demo-heartbeat \"You are demo-heartbeat, a tiny background helper for the lead, the Claude session named 'demo-lead'"
cfg() { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[sys.argv[2]]))' "$repo/.claude/ops-kit.json" "$1"; }
check "config owner" "$(cfg owner)" '"Sam"'
check "config cap" "$(cfg agentCap)" 3
check "config locks" "$(cfg locks)" '[{"name": "check", "timeoutMin": 90}, {"name": "sim", "timeoutMin": 45}]'
check "config check detected" "$(cfg checkCommand)" '"make check"'
check "config heartbeat" "$(cfg heartbeatName)" '"demo-heartbeat"'
check "status.json cap" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["schema"], d["agentLimit"], d["agents"])' "$repo/tmp/ops/status.json")" "1 3 []"
check "backlog.json parses" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["items"])' "$repo/tmp/ops/backlog.json")" "[]"
settings=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["hooks"]["Stop"][0]["hooks"][0]["command"], len(d["permissions"]["allow"]), "Bash(make:*)" in d["permissions"]["allow"], "Bash(claude --bg:*)" in d["permissions"]["allow"], "SendMessage" in d["permissions"]["allow"], "Bash(tools/ops-kit/queue.sh:*)" in d["permissions"]["allow"])' "$repo/.claude/settings.local.json")
check "settings: hooks kept, entries added once" "$settings" "echo mine 28 True True True True"
for p in tmp/ops/status.json tmp/agent-locks/x .claude/settings.local.json; do
  check "$p is ignored" "$(git -C "$repo" check-ignore -q "$p" && echo yes)" yes
done
check "tracked files not ignored" "$(git -C "$repo" check-ignore -q .claude/ops-kit.json || echo tracked)" tracked

# 2. Second run, no flags: nothing written at all.
before=$(snapshot "$repo")
out=$(init)
contains "second run summary" "$out" "INIT: 0 created, 0 updated, 32 unchanged, 0 kept"
check "second run touched nothing" "$(snapshot "$repo")" "$before"
out=$(init --owner Sam --cap 3)
contains "same flags again: nothing" "$out" "0 created, 0 updated"
check "same flags touched nothing" "$(snapshot "$repo")" "$before"

# 3. The tools work from the scaffold: the full check runs and is recorded.
out=$(cd "$repo" && OPS_AGENT_LOCKS="$repo/tmp/agent-locks" tools/ops-kit/fullcheck.sh 2>&1)
contains "fullcheck green" "$out" "FULLCHECK: all green"
check "fullcheck recorded" "$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).readlines()[-1])["result"])' "$repo/tmp/ops/checks.jsonl")" green
python3 - "$repo/.claude/ops-kit.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["fullCheck"] = [{"part": "unit", "lock": "check", "command": "true"}, {"part": "e2e", "lock": "sim", "command": "exit 3"}]
json.dump(d, open(p, "w"), indent=2)
EOF
out=$(cd "$repo" && tools/ops-kit/fullcheck.sh 2>&1)
check "fullcheck exit on failure" "$?" 1
contains "fullcheck names the failed part" "$out" "FULLCHECK: e2e FAILED"
check "failure recorded with its part" "$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).readlines()[-1])["part"])' "$repo/tmp/ops/checks.jsonl")" e2e
out=$(init)
contains "the check text follows fullCheck" "$out" "updated   CLAUDE.md"
contains "CLAUDE.md lists both steps" "$(cat "$repo/CLAUDE.md")" "\`true\` under the \`check\` lock, then \`exit 3\` under the \`sim\` lock"

# 4. An edited file is kept; its new version waits in init-pending; --force takes it.
echo "Our extra rule." >>"$repo/.claude/agents/demo-engineer.md"
out=$(init --owner Kim)
contains "edited agent kept" "$out" "kept      .claude/agents/demo-engineer.md"
contains "unedited agent updated" "$out" "updated   .claude/agents/demo-implementer.md"
contains "edit still there" "$(cat "$repo/.claude/agents/demo-engineer.md")" "Our extra rule."
contains "pending version has the new owner" "$(cat "$repo/tmp/ops/init-pending/.claude/agents/demo-engineer.md")" "The owner is Kim."
contains "CLAUDE.md follows the owner" "$(cat "$repo/CLAUDE.md")" "These rules are Kim's"
out=$(init)
contains "still kept on the next run" "$out" "1 kept"
out=$(init --force .claude/agents/demo-engineer.md)
contains "forced" "$out" "updated   .claude/agents/demo-engineer.md  (forced)"
check "forced file is the kit's" "$(grep -c 'Our extra rule' "$repo/.claude/agents/demo-engineer.md")" 0
out=$(init)
contains "after force: clean" "$out" "0 kept"

# 5. An edited CLAUDE.md section is kept too; text outside it never matters.
python3 - "$repo/CLAUDE.md" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
open(p, "w").write(s.replace("Ask Kim one theme at a time", "Ask Kim anything any time") + "\nMore of our own text.\n")
EOF
out=$(init --owner Lee)
contains "edited section kept" "$out" "kept      CLAUDE.md"
contains "section edit survives" "$(cat "$repo/CLAUDE.md")" "Ask Kim anything any time"
contains "pending section" "$(cat "$repo/tmp/ops/init-pending/CLAUDE.md.ops-kit-section.md")" "Ask Lee one theme at a time"

# 6. A kit upgrade: a file the init wrote and nobody touched follows the kit.
python3 - "$repo" <<'EOF'
import hashlib, json, sys
repo = sys.argv[1]
path = f"{repo}/tools/ops-kit/README.md"
old = open(path).read().replace("Installed by the ops kit", "Installed by an older ops kit")
open(path, "w").write(old)
m = json.load(open(f"{repo}/.claude/ops-kit-files.json"))
m["files"]["tools/ops-kit/README.md"] = hashlib.sha256(old.encode()).hexdigest()
json.dump(m, open(f"{repo}/.claude/ops-kit-files.json", "w"), indent=2)
EOF
out=$(init)
contains "older kit file updated" "$out" "updated   tools/ops-kit/README.md"
contains "to the kit's text" "$(cat "$repo/tools/ops-kit/README.md")" "Installed by the ops kit"

# 7. State files belong to the lead: never rewritten.
echo '{"schema":1,"agents":[{"name":"x"}]}' >"$repo/tmp/ops/status.json"
init >/dev/null
check "status.json kept" "$(cat "$repo/tmp/ops/status.json")" '{"schema":1,"agents":[{"name":"x"}]}'

# 8. From a worktree: tracked files in the worktree, state and settings in the main checkout.
git -C "$repo" add -A >/dev/null && git -C "$repo" commit -qm "ops kit" >/dev/null
git -C "$repo" worktree add -q "$repo-wt" -b setup
rm -rf "$repo/tmp/ops/briefs"
out=$(python3 "$INIT" --repo "$repo-wt" --owner Lee)
contains "worktree run" "$out" "INIT:"
check "state goes to the main checkout" "$([ -d "$repo/tmp/ops/briefs" ] && echo yes)" yes
check "no state in the worktree" "$([ -e "$repo-wt/tmp/ops" ] && echo yes || echo no)" no
git -C "$repo" worktree remove -f "$repo-wt"

# 9. A dry run writes nothing.
dry=$(make_repo)
out=$(python3 "$INIT" --repo "$dry" --dry-run)
contains "dry run says so" "$out" "INIT (dry run):"
check "dry run wrote nothing" "$(cd "$dry" && find . -path ./.git -prune -o -type f -print | sort | tr '\n' ' ')" "./Makefile "
json=$(python3 "$INIT" --repo "$dry" --dry-run --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["config"]["owner"], d["config"]["slug"], d["config"]["checkCommand"])')
check "json defaults" "$json" "Test $(basename "$dry" | tr 'A-Z.' 'a-z-') make check"
rm -rf "$dry"

# 10. Bad input is refused before anything is written.
out=$(python3 "$INIT" --repo "$repo" --slug "Bad Slug" 2>&1)
contains "bad slug refused" "$out" "must be lowercase"
out=$(python3 "$INIT" --repo "$repo" --locks "../x:5" 2>&1)
contains "bad lock refused" "$out" "bad lock name"
out=$(python3 "$INIT" --repo / 2>&1)
contains "not a repo refused" "$out" "not inside a git checkout"

# 11. The files added since the 2026-10-15 kit, on a fresh repo with every option on.
NEW="needs_lead.py quiet.sh claude-agents.sh statusline.py usage_write.py usage_show.py suite_cache.py steps_json.sh main_fullcheck.sh"
full=$(make_repo)
trap 'rm -rf "$repo" "$repo-wt" "${dry:-}" "${full:-}" "${old:-}" "${oldkit:-}"' EXIT
out=$(python3 "$INIT" --repo "$full" --owner Sam --slug demo --agents-account --usage --lanes core:1,flex:2)
contains "full init: lanes in the section" "$(cat "$full/CLAUDE.md")" "core"
for f in $NEW; do check "full: wrote tools/ops-kit/$f" "$([ -s "$full/tools/ops-kit/$f" ] && echo yes)" yes; done
check "full: no placeholder left" "$(grep -rl '{{' "$full/.claude" "$full/tools" "$full/CLAUDE.md" "$full/tmp" | wc -l | tr -d ' ')" 0
check "full: statusLine set" "$(grep -c 'statusline.py' "$full/.claude/settings.json")" 1
check "full: worktrees ignored" "$(git -C "$full" check-ignore -q .claude/worktrees/x/y && echo yes)" yes
check "full: needs_lead.py runs" "$(cd "$full" && OPS_CLAUDE_BIN=true python3 tools/ops-kit/needs_lead.py >/dev/null 2>&1; echo "exit=$?")" "exit=0"
out=$(cd "$full" && OPS_AGENT_LOCKS="$full/tmp/agent-locks" tools/ops-kit/fullcheck.sh 2>&1)
contains "full: fullcheck dry run green" "$out" "FULLCHECK: all green"
out=$(python3 "$INIT" --repo "$full")
contains "full: second run changes nothing" "$out" "0 created, 0 updated"

# 12. A repo initialised by the 2026-10-15 kit upgrades: untouched files follow the kit, edits stay.
oldkit=$(mktemp -d)
if git -C "$KIT" cat-file -e 427592f 2>/dev/null; then
  git -C "$KIT" archive 427592f plugin | tar -x -C "$oldkit"
  old=$(make_repo)
  python3 "$oldkit/plugin/scripts/ops_init.py" --repo "$old" --owner Sam --slug demo >/dev/null || echo "FAIL: old kit init"
  check "old kit lacks needs_lead.py" "$([ -e "$old/tools/ops-kit/needs_lead.py" ] && echo yes || echo no)" no
  echo "Our extra rule." >>"$old/.claude/agents/demo-engineer.md"
  out=$(python3 "$INIT" --repo "$old")
  contains "upgrade: needs_lead.py created" "$out" "created   tools/ops-kit/needs_lead.py"
  contains "upgrade: untouched fullcheck.sh updated" "$out" "updated   tools/ops-kit/fullcheck.sh"
  contains "upgrade: edited agent kept" "$out" "kept      .claude/agents/demo-engineer.md"
  contains "upgrade: its new version waits" "$(cat "$old/tmp/ops/init-pending/.claude/agents/demo-engineer.md")" "demo-engineer"
  check "upgrade: edit survives" "$(grep -c 'Our extra rule' "$old/.claude/agents/demo-engineer.md")" 1
  for f in $NEW; do
    case "$f" in statusline.py | usage_write.py | usage_show.py | claude-agents.sh) continue ;; esac
    check "upgrade: has tools/ops-kit/$f" "$([ -s "$old/tools/ops-kit/$f" ] && echo yes)" yes
  done
  check "upgrade: no placeholder left" "$(grep -rl '{{' "$old/.claude" "$old/tools" "$old/CLAUDE.md" | wc -l | tr -d ' ')" 0
  out=$(cd "$old" && OPS_AGENT_LOCKS="$old/tmp/agent-locks" tools/ops-kit/fullcheck.sh 2>&1)
  contains "upgrade: fullcheck dry run green" "$out" "FULLCHECK: all green"
  check "upgrade: needs_lead.py runs" "$(cd "$old" && OPS_CLAUDE_BIN=true python3 tools/ops-kit/needs_lead.py >/dev/null 2>&1; echo "exit=$?")" "exit=0"
  out=$(python3 "$INIT" --repo "$old")
  contains "upgrade: second run only keeps" "$out" "0 created, 0 updated"
else
  echo "skip: commit 427592f (the 2026-10-15 kit) is not in this clone"
fi
rm -rf "$full" "$old" "$oldkit"

exit $fail
