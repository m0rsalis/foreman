#!/bin/bash
# Tests for claude-agents.sh: setup makes the shared session registry link,
# every run checks it and runs claude on the agents' folder.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
export OPS_AGENTS_CONFIG=$t/agents OPS_MAIN_CONFIG=$t/main OPS_CLAUDE_BIN=$t/fake-claude
printf '#!/bin/bash\necho "CFG=$CLAUDE_CONFIG_DIR ARGS=$*"\n' >"$t/fake-claude"
chmod +x "$t/fake-claude"
mkdir -p "$t/main/sessions"
echo agreements >"$t/main/CLAUDE.md"
W="$KIT/plugin/templates/tools/claude-agents.sh"
# shellcheck disable=SC2254  # the expected value is a glob on purpose
glob() { case "$2" in $3) echo "ok: $1" ;; *) echo "FAIL: $1 (got '$2', want '$3')"; fail=1 ;; esac; }

glob "run before setup refuses" "$(bash "$W" agents 2>&1; echo "exit=$?")" "*not a link*exit=2"
glob "setup succeeds" "$(bash "$W" --setup; echo "exit=$?")" "*ready*exit=0"
check "sessions linked to main" "$(readlink "$t/agents/sessions")" "$t/main/sessions"
check "global CLAUDE.md shared" "$(cat "$t/agents/CLAUDE.md")" "agreements"
glob "own settings" "$(cat "$t/agents/settings.json")" "*CLAUDE_CODE_FORK_SUBAGENT*"
check "setup is repeatable" "$(bash "$W" --setup >/dev/null; echo "exit=$?")" "exit=0"
check "runs claude on the agents folder" "$(bash "$W" --bg -w x --name x 'a b')" "CFG=$t/agents ARGS=--bg -w x --name x a b"
check "keeps the exit code" "$(OPS_CLAUDE_BIN=false bash "$W" x; echo "exit=$?")" "exit=1"

# A real sessions folder with registrations: setup refuses and leaves it.
rm "$t/agents/sessions" && mkdir "$t/agents/sessions" && touch "$t/agents/sessions/123.json"
glob "run with a folder refuses" "$(bash "$W" agents 2>&1; echo "exit=$?")" "*not a link*exit=2"
glob "setup with live files refuses" "$(bash "$W" --setup 2>&1; echo "exit=$?")" "*folder with files*exit=2"
check "files left alone" "$(ls "$t/agents/sessions")" "123.json"
exit $fail
