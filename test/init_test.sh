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
for f in .claude/foreman.json .claude/foreman-files.json .claude/agents/demo-engineer.md .claude/agents/demo-implementer.md \
  .claude/agents/demo-checker.md tools/foreman/queue.sh tools/foreman/queue_lock.py tools/foreman/queue_run.py \
  tools/foreman/fullcheck.sh tools/foreman/run_action.sh tools/foreman/lead_status.py tools/foreman/ops_config.py \
  tools/foreman/README.md tools/foreman/heartbeat.md tmp/ops/status.json tmp/ops/backlog.json tmp/ops/lead-notes.md .gitignore; do
  check "wrote $f" "$([ -s "$repo/$f" ] && echo yes)" yes
done
for d in tmp/ops/briefs tmp/ops/reports; do check "made $d/" "$([ -d "$repo/$d" ] && echo yes)" yes; done
for f in queue.sh fullcheck.sh run_action.sh lead_status.py ops_config.py queue_lock.py queue_run.py; do
  check "$f is executable" "$([ -x "$repo/tools/foreman/$f" ] && echo yes)" yes
done
check "no placeholder left" "$(grep -rl '{{' "$repo/.claude" "$repo/tools" "$repo/CLAUDE.md" "$repo/tmp" | wc -l | tr -d ' ')" 0
check "engineer is opus" "$(grep -c '^model: opus$' "$repo/.claude/agents/demo-engineer.md")" 1
check "implementer is sonnet" "$(grep -c '^model: sonnet$' "$repo/.claude/agents/demo-implementer.md")" 1
check "checker is haiku" "$(grep -c '^model: haiku$' "$repo/.claude/agents/demo-checker.md")" 1
check "agent names carry the slug" "$(grep -h '^name:' "$repo"/.claude/agents/demo-*.md | tr '\n' ' ')" "name: demo-checker name: demo-engineer name: demo-implementer "
md=$(cat "$repo/CLAUDE.md")
contains "CLAUDE.md keeps its own text" "$md" "Our own rules."
contains "CLAUDE.md has the section" "$md" "<!-- foreman:begin"
contains "CLAUDE.md names the owner" "$md" "These rules are Sam's"
contains "CLAUDE.md names the lead" "$md" "The lead's session name is \`demo-lead\`"
contains "CLAUDE.md names the locks" "$md" "declared locks: \`check\`, \`sim\`"
contains "CLAUDE.md names the check" "$md" "full check (\`make check\`)"
contains "heartbeat command names the lead" "$(cat "$repo/tools/foreman/heartbeat.md")" "--name demo-heartbeat \"You are demo-heartbeat, a tiny background helper for the lead, the Claude session named 'demo-lead'"
cfg() { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[sys.argv[2]]))' "$repo/.claude/foreman.json" "$1"; }
check "config owner" "$(cfg owner)" '"Sam"'
check "config cap" "$(cfg agentCap)" 3
check "config locks" "$(cfg locks)" '[{"name": "check", "timeoutMin": 90}, {"name": "sim", "timeoutMin": 45}]'
check "config check detected" "$(cfg checkCommand)" '"make check"'
check "config heartbeat" "$(cfg heartbeatName)" '"demo-heartbeat"'
check "status.json cap" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["schema"], d["agentLimit"], d["agents"])' "$repo/tmp/ops/status.json")" "1 3 []"
check "backlog.json parses" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["items"])' "$repo/tmp/ops/backlog.json")" "[]"
settings=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["hooks"]["Stop"][0]["hooks"][0]["command"], len(d["permissions"]["allow"]), "Bash(make:*)" in d["permissions"]["allow"], "Bash(claude --bg:*)" in d["permissions"]["allow"], "SendMessage" in d["permissions"]["allow"], "Bash(tools/foreman/queue.sh:*)" in d["permissions"]["allow"])' "$repo/.claude/settings.local.json")
check "settings: hooks kept, entries added once" "$settings" "echo mine 28 True True True True"
for p in tmp/ops/status.json tmp/agent-locks/x .claude/settings.local.json; do
  check "$p is ignored" "$(git -C "$repo" check-ignore -q "$p" && echo yes)" yes
done
check "tracked files not ignored" "$(git -C "$repo" check-ignore -q .claude/foreman.json || echo tracked)" tracked

# 2. Second run, no flags: nothing written at all.
before=$(snapshot "$repo")
out=$(init)
contains "second run summary" "$out" "INIT: 0 created, 0 updated, 32 unchanged, 0 kept"
check "second run touched nothing" "$(snapshot "$repo")" "$before"
out=$(init --owner Sam --cap 3)
contains "same flags again: nothing" "$out" "0 created, 0 updated"
check "same flags touched nothing" "$(snapshot "$repo")" "$before"

# 3. The tools work from the scaffold: the full check runs and is recorded.
out=$(cd "$repo" && OPS_AGENT_LOCKS="$repo/tmp/agent-locks" tools/foreman/fullcheck.sh 2>&1)
contains "fullcheck green" "$out" "FULLCHECK: all green"
check "fullcheck recorded" "$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).readlines()[-1])["result"])' "$repo/tmp/ops/checks.jsonl")" green
python3 - "$repo/.claude/foreman.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["fullCheck"] = [{"part": "unit", "lock": "check", "command": "true"}, {"part": "e2e", "lock": "sim", "command": "exit 3"}]
json.dump(d, open(p, "w"), indent=2)
EOF
out=$(cd "$repo" && tools/foreman/fullcheck.sh 2>&1)
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
contains "pending section" "$(cat "$repo/tmp/ops/init-pending/CLAUDE.md.foreman-section.md")" "Ask Lee one theme at a time"

# 6. A kit upgrade: a file the init wrote and nobody touched follows the kit.
python3 - "$repo" <<'EOF'
import hashlib, json, sys
repo = sys.argv[1]
path = f"{repo}/tools/foreman/README.md"
old = open(path).read().replace("Installed by Foreman", "Installed by an older Foreman")
open(path, "w").write(old)
m = json.load(open(f"{repo}/.claude/foreman-files.json"))
m["files"]["tools/foreman/README.md"] = hashlib.sha256(old.encode()).hexdigest()
json.dump(m, open(f"{repo}/.claude/foreman-files.json", "w"), indent=2)
EOF
out=$(init)
contains "older kit file updated" "$out" "updated   tools/foreman/README.md"
contains "to the kit's text" "$(cat "$repo/tools/foreman/README.md")" "Installed by Foreman"

# 7. State files belong to the lead: never rewritten.
echo '{"schema":1,"agents":[{"name":"x"}]}' >"$repo/tmp/ops/status.json"
init >/dev/null
check "status.json kept" "$(cat "$repo/tmp/ops/status.json")" '{"schema":1,"agents":[{"name":"x"}]}'

# 8. From a worktree: tracked files in the worktree, state and settings in the main checkout.
git -C "$repo" add -A >/dev/null && git -C "$repo" commit -qm "foreman" >/dev/null
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
for f in $NEW; do check "full: wrote tools/foreman/$f" "$([ -s "$full/tools/foreman/$f" ] && echo yes)" yes; done
check "full: no placeholder left" "$(grep -rl '{{' "$full/.claude" "$full/tools" "$full/CLAUDE.md" "$full/tmp" | wc -l | tr -d ' ')" 0
check "full: statusLine set" "$(grep -c 'statusline.py' "$full/.claude/settings.json")" 1
check "full: worktrees ignored" "$(git -C "$full" check-ignore -q .claude/worktrees/x/y && echo yes)" yes
check "full: needs_lead.py runs" "$(cd "$full" && OPS_CLAUDE_BIN=true python3 tools/foreman/needs_lead.py >/dev/null 2>&1; echo "exit=$?")" "exit=0"
out=$(cd "$full" && OPS_AGENT_LOCKS="$full/tmp/agent-locks" tools/foreman/fullcheck.sh 2>&1)
contains "full: fullcheck dry run green" "$out" "FULLCHECK: all green"
out=$(python3 "$INIT" --repo "$full")
contains "full: second run changes nothing" "$out" "0 created, 0 updated"

# 12. A repo initialised by the 2026-10-15 kit (then named ops-kit) upgrades: the old names are
# adopted in place, untouched files follow the kit, edits stay.
oldkit=$(mktemp -d)
if git -C "$KIT" cat-file -e 427592f 2>/dev/null; then
  git -C "$KIT" archive 427592f plugin | tar -x -C "$oldkit"
  old=$(make_repo)
  python3 "$oldkit/plugin/scripts/ops_init.py" --repo "$old" --owner Sam --slug demo >/dev/null || echo "FAIL: old kit init"
  check "old kit lacks needs_lead.py" "$([ -e "$old/tools/ops-kit/fullcheck.sh" ] && [ ! -e "$old/tools/ops-kit/needs_lead.py" ] && echo yes || echo no)" yes
  echo "Our extra rule." >>"$old/.claude/agents/demo-engineer.md"
  out=$(python3 "$INIT" --repo "$old" --dry-run --json)
  check "legacy dry run: config adopted in memory" "$(printf '%s' "$out" | python3 -c 'import json,sys; c=json.load(sys.stdin)["config"]; print(c["toolsDir"], c["owner"])')" "tools/foreman Sam"
  check "legacy dry run: touches nothing" "$([ -e "$old/.claude/ops-kit.json" ] && [ -d "$old/tools/ops-kit" ] && [ ! -e "$old/.claude/foreman.json" ] && echo yes)" yes
  out=$(python3 "$INIT" --repo "$old")
  contains "upgrade: config adopted" "$out" "adopted   .claude/foreman.json"
  contains "upgrade: tools folder moved" "$out" "adopted   tools/foreman/"
  contains "upgrade: markers renamed" "$out" "adopted   CLAUDE.md"
  check "upgrade: old names gone" "$(ls -d "$old/.claude/ops-kit.json" "$old/.claude/ops-kit-files.json" "$old/tools/ops-kit" 2>/dev/null | wc -l | tr -d ' ')" 0
  check "upgrade: one section, new markers" "$(grep -c 'foreman:begin' "$old/CLAUDE.md") $(grep -c 'ops-kit:' "$old/CLAUDE.md")" "1 0"
  contains "upgrade: CLAUDE.md section followed the kit" "$out" "updated   CLAUDE.md"
  contains "upgrade: needs_lead.py created" "$out" "created   tools/foreman/needs_lead.py"
  contains "upgrade: untouched fullcheck.sh updated" "$out" "updated   tools/foreman/fullcheck.sh"
  contains "upgrade: edited agent kept" "$out" "kept      .claude/agents/demo-engineer.md"
  contains "upgrade: its new version waits" "$(cat "$old/tmp/ops/init-pending/.claude/agents/demo-engineer.md")" "demo-engineer"
  check "upgrade: edit survives" "$(grep -c 'Our extra rule' "$old/.claude/agents/demo-engineer.md")" 1
  for f in $NEW; do
    case "$f" in statusline.py | usage_write.py | usage_show.py | claude-agents.sh) continue ;; esac
    check "upgrade: has tools/foreman/$f" "$([ -s "$old/tools/foreman/$f" ] && echo yes)" yes
  done
  check "upgrade: no placeholder left" "$(grep -rl '{{' "$old/.claude" "$old/tools" "$old/CLAUDE.md" | wc -l | tr -d ' ')" 0
  out=$(cd "$old" && OPS_AGENT_LOCKS="$old/tmp/agent-locks" tools/foreman/fullcheck.sh 2>&1)
  contains "upgrade: fullcheck dry run green" "$out" "FULLCHECK: all green"
  check "upgrade: needs_lead.py runs" "$(cd "$old" && OPS_CLAUDE_BIN=true python3 tools/foreman/needs_lead.py >/dev/null 2>&1; echo "exit=$?")" "exit=0"
  out=$(python3 "$INIT" --repo "$old")
  contains "upgrade: second run only keeps" "$out" "0 created, 0 updated"
else
  echo "skip: commit 427592f (the 2026-10-15 kit) is not in this clone"
fi
rm -rf "$full" "$old" "$oldkit"

# 13. Who merges and how (mergeBy, mergeMethod): settings the agent files and the section are
# rendered from, so a repo whose lead merges (a review bot gates merges) keeps the kit's agent
# files and their updates. `gh pr merge` is allowed without asking only where agents merge.
dflt=$(make_repo)
lead=$(make_repo)
trap 'rm -rf "$repo" "$repo-wt" "${dry:-}" "${dflt:-}" "${lead:-}" "${cw:-}" "${tipr:-}" "${fakegh:-}"' EXIT
# The CLAUDE.md section per mergeMethod. After a squash or rebase merge the PR branch is never an
# ancestor of main, so `git branch -d` always refuses ("not fully merged"): the section says -D then,
# but only for a PR that shows MERGED, never on ancestry (a CLOSED PR's branch may be the only copy).
# The `worktree-<task>` branch `claude --bg -w` made keeps -d, and -d refusing means unmerged commits.
# The clean-green test, pinned as the inventory repo tested it: it accepts "(0 of 2 steps cached)" and
# "(2 of 2 steps cached)" and rejects the other three lines that start "all green at", and a FAILED line.
clean_green="tail -n 1 <log> | grep -Eq '^FULLCHECK: all green at [0-9a-f]+ \\([0-9]+ of [0-9]+ steps cached\\)\$'"
# The branch-delete test: -D only when this succeeds, i.e. the PR is MERGED and the branch's tip IS the head it
# merged. The 0.4.1 text checked the PR's state alone, so a branch reused for a newer PR was force-deleted.
tip_check=$(cat <<'EOF'
tip="$(git rev-parse --verify -q refs/heads/<branch>)"; [ -n "$tip" ] && [ "$(gh pr view <n> --json state,mergedAt,headRefOid --jq 'select(.state == "MERGED" and .mergedAt != null) | .headRefOid')" = "$tip" ]
EOF
)
method_text_checks() { # <label> <repo> <method>
  local label=$1 dir=$2 method=$3 md after
  md=$(cat "$dir/CLAUDE.md")
  after=$(grep '^- \*\*After a merge' "$dir/CLAUDE.md")
  contains "$label: the PR head check expands the short sha" "$md" "\`[ \"\$(gh pr view <n> --json headRefOid --jq .headRefOid)\" = \"\$(git rev-parse <sha>)\" ]\`"
  # Every text that acts on a FULLCHECK line tests it with the clean-green command, not the prefix, and
  # fetches right before the ancestor check. Each scan first has to see its sites: a scan that matches
  # nothing looks like one that finds nothing. Both mergeBy renderings pass through here.
  hits=$(grep -n "all green at" "$dir/CLAUDE.md" "$dir/.claude/agents/"*.md)
  check "$label: all-green sites found: section, three agents" "$([ "$(printf '%s\n' "$hits" | wc -l)" -ge 5 ] && echo yes)" yes
  check "$label: every all-green line names the clean form" "$(printf '%s\n' "$hits" | grep -v 'steps cached')" ""
  hits=$(grep -n "is-ancestor" "$dir/CLAUDE.md" "$dir/.claude/agents/"*.md)
  check "$label: ancestor sites found: section, three agents" "$([ "$(printf '%s\n' "$hits" | wc -l)" -ge 4 ] && echo yes)" yes
  check "$label: every ancestor check follows git fetch origin" "$(printf '%s\n' "$hits" | grep -v 'git fetch origin')" ""
  contains "$label: merge discipline accepts only the clean green" "$md" "only on a clean green: the last line of the check's log passes \`$clean_green\` (the other lines that start"
  contains "$label: fetch right before the ancestor check" "$md" "Then \`git fetch origin\` immediately before \`git merge-base --is-ancestor origin/main <that sha>\`"
  contains "$label: a -d refusal on the -w branch means look first" "$after" "(\`git log origin/main.."
  contains "$label: ... before forcing" "$after" "before forcing."
  check "$label: the -w branch is never force-deleted" "$(printf '%s' "$after" | grep -c 'branch -D worktree')" 0
  if [ "$method" = merge ]; then
    contains "$label: the merged branch goes with -d" "$after" "\`git branch -d <branch>\` for the merged branch and \`git branch -d worktree-<task>\`"
    check "$label: no -D anywhere" "$(printf '%s' "$after" | grep -c 'branch -D')" 0
    check "$label: no PR state lookup" "$(printf '%s' "$after" | grep -c 'mergedAt')" 0
    check "$label: no tip test (-d checks ancestry itself)" "$(printf '%s' "$after" | grep -c 'refs/heads/')" 0
  else
    contains "$label: the PR branch goes with -D" "$after" "the PR branch with \`git branch -D <branch>\`"
    contains "$label: -D only when the tip test succeeds" "$after" "the PR branch with \`git branch -D <branch>\`, only when \`$tip_check\` succeeds"
    contains "$label: ... the PR is merged and the tip is its head" "$after" "PR \`<n>\` shows \`state\` \`MERGED\` and a \`mergedAt\` that is not null, and the branch's local tip is the head that PR merged"
    contains "$label: a branch that moved on is kept, and looked at" "$after" "a branch that moved past the merged head (reused for a newer PR, or committed to after the merge) all fail it: keep the branch and look at"
    contains "$label: cleanup runs before the branch can be reused" "$after" "Run it right after the merge, before the branch can be reused, and in any later clean-up pass too"
    hits=$(grep -n 'branch -D' "$dir/CLAUDE.md" "$dir/.claude/agents/"*.md)
    check "$label: -D site found: the section" "$(printf '%s\n' "$hits" | wc -l | tr -d ' ')" 1
    check "$label: every -D line carries the tip test" "$(printf '%s\n' "$hits" | grep -v 'refs/heads/<branch>')" ""
    contains "$label: names the method" "$after" "(A $method merge puts new commits on \`main\`"
    contains "$label: never on ancestry" "$after" "never decide on ancestry"
    contains "$label: a closed PR's branch is kept" "$after" "keep the branch of a \`CLOSED\` PR"
    contains "$label: the -w branch keeps -d" "$after" "keeps \`git branch -d\`"
    check "$label: -D once, for the PR branch" "$(printf '%s' "$after" | grep -o 'branch -D' | wc -l | tr -d ' ')" 1
    check "$label: no plain -d on the PR branch" "$(printf '%s' "$after" | grep -c 'branch -d <branch>')" 0
  fi
}
python3 "$INIT" --repo "$dflt" --owner Sam --slug demo >/dev/null
method_text_checks "merge method" "$dflt" merge
for f in engineer implementer checker; do
  contains "default: $f merges with --merge" "$(cat "$dflt/.claude/agents/demo-$f.md")" "\`gh pr merge <n> --merge\`"
done
contains "default: one line after each merge" "$(cat "$dflt/.claude/agents/demo-engineer.md")" "SendMessage only: one line after each merge;"
md=$(cat "$dflt/CLAUDE.md")
contains "default: agents merge" "$md" "**Merge discipline:** agents merge their own PRs, and only on"
contains "default: one message per merge" "$md" "one message per merge or stop"
contains "default: merge allowed" "$(cat "$dflt/.claude/settings.local.json")" "\"Bash(gh pr merge:*)\""
out=$(python3 "$INIT" --repo "$dflt" --merge-method rebase)
contains "method change: untouched agent updated" "$out" "updated   .claude/agents/demo-checker.md"
contains "method change: rebase" "$(cat "$dflt/.claude/agents/demo-checker.md")" "\`gh pr merge <n> --rebase\`"
method_text_checks "rebase method" "$dflt" rebase

python3 "$INIT" --repo "$lead" --owner Sam --slug demo --merge-by lead --merge-method squash >/dev/null
check "lead merges: config" "$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c["mergeBy"], c["mergeMethod"])' "$lead/.claude/foreman.json")" "lead squash"
for f in engineer implementer checker; do
  check "lead merges: $f never runs gh pr merge" "$(grep -c 'gh pr merge' "$lead/.claude/agents/demo-$f.md")" 0
done
contains "lead merges: engineer stops at ready" "$(cat "$lead/.claude/agents/demo-engineer.md")" "Report the PR ready only on a clean green: the log's last line passes"
contains "lead merges: implementer reports ready" "$(cat "$lead/.claude/agents/demo-implementer.md")" "SendMessage only: one line when a PR is ready for the lead to merge;"
contains "lead merges: checker job" "$(cat "$lead/.claude/agents/demo-checker.md")" "## Typical job: check a PR for the lead to merge"
md=$(cat "$lead/CLAUDE.md")
contains "lead merges: the lead merges" "$md" "**Merge discipline:** the lead merges (an agent reports its PR ready and never merges it), and only on"
contains "lead merges: with the method" "$md" "before \`gh pr merge <n> --squash\`"
contains "lead merges: one message per PR ready" "$md" "one message per PR ready or stop"
check "lead merges: gh pr merge not allowed" "$(grep -c 'gh pr merge' "$lead/.claude/settings.local.json")" 0
method_text_checks "squash method" "$lead" squash
out=$(python3 "$INIT" --repo "$lead" --merge-by bot 2>&1)
contains "bad mergeBy flag refused" "$out" "invalid choice: 'bot'"
python3 - "$lead/.claude/foreman.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["mergeMethod"] = "fast-forward"; json.dump(d, open(p, "w"))
EOF
out=$(python3 "$INIT" --repo "$lead" 2>&1)
contains "bad mergeMethod in the config refused" "$out" "mergeMethod 'fast-forward' in .claude/foreman.json must be one of merge, squash, rebase"

# Previews: an agent's sandbox cannot write the main checkout, so it keeps them in its own
# worktree's tmp/previews/ (ignored, so its full check stays clean) and the lead copies them out.
check "previews folder ignored" "$(git -C "$dflt" check-ignore -q tmp/previews/x && echo yes)" yes
contains "previews: the lead copies them" "$(cat "$dflt/CLAUDE.md")" "the lead copies them into \`tmp/previews\` in the main checkout"
contains "previews: the agent keeps them" "$(cat "$dflt/.claude/agents/demo-engineer.md")" "go in your worktree's own \`tmp/previews/\`"
check "launch command is no pipeline" "$(grep -c 'engineer|' "$dflt/CLAUDE.md")" 0
contains "launch command names the tiers" "$(cat "$dflt/CLAUDE.md")" "--agent <tier> --permission-mode auto"

# 14. The compaction window is autoCompactWindow alone: CLAUDE_CODE_AUTO_COMPACT_WINDOW outranks
# --autocompact, so with it no task could get a bigger window. Never written; the value earlier
# kits wrote is removed (an emptied env with it); a value of the repo's own stays.
cw=$(make_repo)
settings() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])))' "$cw/.claude/settings.json"; }
python3 "$INIT" --repo "$cw" >/dev/null
check "compaction: only the key" "$(settings)" "{'autoCompactWindow': 300000}"
# A repo that deleted the variable by hand: a rerun must not bring it back.
printf '{"autoCompactWindow":300000}\n' >"$cw/.claude/settings.json"
python3 "$INIT" --repo "$cw" >/dev/null
check "compaction: a rerun adds no variable" "$(settings)" "{'autoCompactWindow': 300000}"
contains "compaction: the section says --autocompact" "$(cat "$cw/CLAUDE.md")" "gets \`--autocompact <size>\` (\`500k\`, say) on its launch command"
printf '{"autoCompactWindow":300000,"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"300000","FOO":"1"}}\n' >"$cw/.claude/settings.json"
out=$(python3 "$INIT" --repo "$cw")
contains "compaction: earlier kit's variable removed" "$out" "updated   .claude/settings.json  (removed env.CLAUDE_CODE_AUTO_COMPACT_WINDOW"
check "compaction: other env kept" "$(settings)" "{'autoCompactWindow': 300000, 'env': {'FOO': '1'}}"
printf '{"autoCompactWindow":300000,"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"300000"}}\n' >"$cw/.claude/settings.json"
python3 "$INIT" --repo "$cw" >/dev/null
check "compaction: emptied env dropped" "$(settings)" "{'autoCompactWindow': 300000}"
printf '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"500000"}}\n' >"$cw/.claude/settings.json"
python3 "$INIT" --repo "$cw" >/dev/null
check "compaction: a value of the repo's own stays" "$(settings)" "{'env': {'CLAUDE_CODE_AUTO_COMPACT_WINDOW': '500000'}, 'autoCompactWindow': 300000}"

# 15. The merge skill's text, and the check that the PR's head is the commit the full check named.
# The skill is not rendered, so its wording is checked in the file.
skill=$(cat "$KIT/plugin/skills/merge/SKILL.md")
contains "merge skill: merge uses -d" "$skill" "- \`merge\`: \`git branch -d <branch>\`."
contains "merge skill: squash and rebase use -D, only when the tip test succeeds" "$skill" "- \`squash\` or \`rebase\`: \`git branch -D <branch>\`, only when \`$tip_check\` succeeds: PR \`<n>\` shows \`state\` \`MERGED\` and a \`mergedAt\` that is not null, and the branch's local tip is the head that PR merged"
contains "merge skill: a branch that moved on is kept, and looked at" "$skill" "all fail it: keep the branch and look at \`git log origin/<mainBranch>..<branch>\` first"
contains "merge skill: cleanup runs before the branch can be reused" "$skill" "Run it right after the merge, before the branch can be reused, and in any later clean-up pass too"
contains "README: -D needs the branch tip to be the merged head" "$(cat "$KIT/README.md")" "and the branch's local tip is that \`headRefOid\` (a branch reused for a newer PR, or committed to after the merge, has moved past it and is kept)"
contains "check-in skill: its disk pass is tip-tested" "$(cat "$KIT/plugin/skills/check-in/SKILL.md")" "A branch is deleted only by its tip test there: a branch that moved on since the merge is kept."
contains "merge skill: never on ancestry" "$skill" "Never decide on ancestry, and keep the branch of a \`CLOSED\` PR."
contains "merge skill: a closed PR's branch is kept" "$skill" "keep the branch of a \`CLOSED\` PR"
contains "merge skill: the -w branch keeps -d" "$skill" "\`git branch -d worktree-<task>\`"
contains "merge skill: look before forcing" "$skill" "before forcing."
check "merge skill: -D only on the squash or rebase line" "$(printf '%s\n' "$skill" | grep -c 'branch -D')" 1
contains "merge skill: accepts only the clean green" "$skill" "A PR merges only on a clean green from \`<toolsDir>/fullcheck.sh\`: the last line of the check's log passes \`$clean_green\`"
contains "merge skill: fetch right before the ancestor check" "$skill" "\`git fetch origin\` immediately before \`git merge-base --is-ancestor origin/<mainBranch> <sha>\`"
contains "merge skill: the PR head check expands the short sha" "$skill" "\`[ \"\$(gh pr view <n> --json headRefOid --jq .headRefOid)\" = \"\$(git rev-parse <sha>)\" ]\`"

# fullcheck.sh prints an abbreviated sha and `gh pr view --json headRefOid` is all 40 characters, so
# comparing the two as strings never matches. Every text that tells an agent to check the PR's head
# must expand the short sha with git rev-parse. The scan has to see the sites first: a scan that
# matches nothing looks like one that finds nothing.
hits=$(grep -n headRefOid "$lead/CLAUDE.md" "$lead/.claude/agents/"*.md "$KIT/plugin/skills/"*/SKILL.md)
check "PR head sites found: section, three agents, merge skill" "$([ "$(printf '%s\n' "$hits" | wc -l)" -ge 5 ] && echo yes)" yes
check "every headRefOid line expands the sha with git rev-parse <sha> (or is the branch-delete tip test)" "$(printf '%s\n' "$hits" | grep -v 'refs/heads/<branch>' | grep -v 'git rev-parse <sha>')" ""

# The same two scans over the skills (the section and the agents are scanned per rendering above).
hits=$(grep -n "all green at" "$KIT/plugin/skills/"*/SKILL.md)
check "skills: all-green site found: merge" "$([ "$(printf '%s\n' "$hits" | wc -l)" -ge 1 ] && echo yes)" yes
check "skills: every all-green line names the clean form" "$(printf '%s\n' "$hits" | grep -v 'steps cached')" ""
hits=$(grep -n "is-ancestor" "$KIT/plugin/skills/"*/SKILL.md)
check "skills: ancestor sites found: merge, brief" "$([ "$(printf '%s\n' "$hits" | wc -l)" -ge 2 ] && echo yes)" yes
check "skills: every ancestor check follows git fetch origin" "$(printf '%s\n' "$hits" | grep -v 'git fetch origin')" ""

# The command from the rendered checker, run for real: the sha a real fullcheck.sh run printed, a
# repo, and a stand-in `gh` that answers only the call the checker is told to make.
out=$(cd "$lead" && OPS_AGENT_LOCKS="$lead/tmp/agent-locks" tools/foreman/fullcheck.sh 2>&1)
short=$(printf '%s\n' "$out" | sed -n 's/^FULLCHECK: all green at \([0-9a-f]*\).*/\1/p')
full=$(git -C "$lead" rev-parse HEAD)
check "fullcheck.sh names an abbreviated sha" "$([ -n "$short" ] && [ "${#short}" -lt 40 ] && [ "${full#"$short"}" != "$full" ] && echo yes)" yes
check "so comparing it with headRefOid as strings never matches" "$([ "$short" = "$full" ] && echo match || echo differ)" differ
mkdir -p "$lead/tmp/fakebin"
printf '%s\n' '#!/bin/bash' \
  '[ "$*" = "pr view 7 --json headRefOid --jq .headRefOid" ] && { echo "$FAKE_HEAD"; exit 0; }' \
  'exit 2' >"$lead/tmp/fakebin/gh"
chmod +x "$lead/tmp/fakebin/gh"
cmd=$(grep -o '\[ "\$(gh pr view <n> --json headRefOid[^`]*\]' "$lead/.claude/agents/demo-checker.md")
check "the checker carries the command" "$([ -n "$cmd" ] && echo yes)" yes
cmd=${cmd//<n>/7}
cmd=${cmd//<sha>/$short}
head_is() { (cd "$lead" && PATH="$lead/tmp/fakebin:$PATH" FAKE_HEAD="$1" bash -c "$cmd"); }
head_is "$full"
check "PR head is the checked commit: succeeds" "$?" 0
git -C "$lead" commit -q --allow-empty -m "pushed after the check"
head_is "$(git -C "$lead" rev-parse HEAD)"
check "PR head moved past the checked commit: fails" "$?" 1
head_is "$full"
check "the short sha still names the checked commit: succeeds" "$?" 0
head_is ""
check "gh printing nothing: fails" "$?" 1

# 16. The squash/rebase branch deletion, run for real: the tip test from the rendered section, in a repo,
# against a stand-in `gh` that applies the command's own --jq filter (with jq) to canned PR JSON, and only
# to the fields the command asked for, as gh does. Each case checks the test's exit status, and where it
# succeeds the `git branch -D` that follows. The 0.4.1 rule (state and mergedAt alone) said delete for the
# branch that had moved past the merged head; a missing branch plus a PR that prints nothing is the
# absent-input bypass (two empty strings compare equal).
if command -v jq >/dev/null; then
  tipr=$(make_repo)
  fakegh=$(mktemp -d "${TMPDIR:-/tmp}/foreman-fakegh.XXXXXX")
  cat >"$fakegh/gh" <<'EOF'
#!/bin/bash
# gh pr view 7 --json <fields> --jq <filter>, answered from $FAKE_PR_JSON; any other call fails
[ "$1 $2 $3 $4 $6" = "pr view 7 --json --jq" ] || exit 2
[ -n "$FAKE_PR_JSON" ] || exit 1
printf '%s' "$FAKE_PR_JSON" | jq -c --arg f "$5" '($f | split(",")) as $k | with_entries(select(.key as $x | $k | index($x)))' | jq -r "$7"
EOF
  chmod +x "$fakegh/gh"
  cmd=$(grep -o 'tip="[^`]*' "$lead/CLAUDE.md")
  check "the rendered section carries one tip test" "$(printf '%s\n' "$cmd" | wc -l | tr -d ' ')" 1
  check "it is the pinned command" "$cmd" "$tip_check"
  check "the merge skill carries the same command" "$(grep -o 'tip="[^`]*' "$KIT/plugin/skills/merge/SKILL.md")" "$cmd"
  cmd=${cmd//<n>/7}
  cmd=${cmd//<branch>/fix\/tip-test}
  tree=$(git -C "$tipr" rev-parse 'HEAD^{tree}')
  merged_head=$(git -C "$tipr" commit-tree -p HEAD -m "the PR's last commit" "$tree")
  moved_on=$(git -C "$tipr" commit-tree -p "$merged_head" -m "committed after the merge" "$tree")
  pr() { printf '{"state":"%s","mergedAt":%s,"headRefOid":"%s"}' "$1" "$2" "$3"; } # <state> <mergedAt json> <head>
  at=\"2026-11-01T10:00:00Z\"
  merged=$(pr MERGED "$at" "$merged_head")
  tip_test() { (cd "$tipr" && PATH="$fakegh:$PATH" FAKE_PR_JSON="$1" bash -c "$cmd" 2>/dev/null); }
  fate() { git -C "$tipr" rev-parse --verify -q refs/heads/fix/tip-test >/dev/null && echo kept || echo deleted; }

  git -C "$tipr" branch -f fix/tip-test "$merged_head"
  tip_test "$merged"
  check "tip is the merged head: the test succeeds" "$?" 0
  tip_test "$merged" && git -C "$tipr" branch -D fix/tip-test >/dev/null
  check "... and the branch is deleted" "$(fate)" deleted

  git -C "$tipr" branch -f fix/tip-test "$moved_on"
  tip_test "$merged"
  check "tip moved past the merged head: the test fails" "$?" 1
  tip_test "$merged" && git -C "$tipr" branch -D fix/tip-test >/dev/null
  check "... and the branch is kept, with the newer commit" "$(fate) $(git -C "$tipr" rev-parse refs/heads/fix/tip-test)" "kept $moved_on"

  git -C "$tipr" branch -f fix/tip-test "$merged_head"
  tip_test "$(pr OPEN null "$merged_head")"
  check "PR still open, tip is its head: fails" "$?" 1
  tip_test "$(pr CLOSED null "$merged_head")"
  check "PR closed unmerged, tip is its head: fails" "$?" 1
  tip_test "$(pr MERGED null "$merged_head")"
  check "state MERGED but no mergedAt: fails" "$?" 1
  tip_test "$(pr CLOSED "$at" "$merged_head")"
  check "a mergedAt but state not MERGED: fails" "$?" 1
  tip_test ""
  check "gh failing: fails" "$?" 1
  tip_test "$(pr MERGED "$at" "$moved_on")"
  check "the merged head is not the tip: fails" "$?" 1

  git -C "$tipr" branch -D fix/tip-test >/dev/null
  tip_test "$merged"
  check "branch missing, PR merged: fails" "$?" 1
  tip_test "$(pr OPEN null "$merged_head")"
  check "branch missing and gh prints nothing: fails (two empty strings are not a match)" "$?" 1
else
  echo "skip: jq is not installed, the branch-delete tip test was not run"
fi

exit $fail
