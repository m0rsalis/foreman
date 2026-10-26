#!/bin/bash
# `claude` on the agents' account: the second subscription that background
# agents run on, so their usage limit is not the lead's. Start, resume, list,
# stop and remove agents (and the heartbeat) through this; the lead stays on
# whatever account its own session is signed in to.
#
#   claude-agents.sh --setup     one-time: make the config folder
#   claude-agents.sh <args...>   claude <args...> on that account
#
# The folder (OPS_AGENTS_CONFIG, default ~/.claude-agents) holds its own login
# and its own background service. Its `sessions` folder must be a link to the
# main folder's: that registry is how sessions find each other by name, so
# without it SendMessage fails both ways (lead to agent, agent to lead). Every
# run checks the link and refuses (exit 2) when it is missing.
# Sign in once after --setup (the lead cannot): CLAUDE_CONFIG_DIR=<folder> claude
# in the repo, accept the folder trust, /exit.
set -u
agents=${OPS_AGENTS_CONFIG:-$HOME/.claude-agents}
main=${OPS_MAIN_CONFIG:-$HOME/.claude}
bin=${OPS_CLAUDE_BIN:-claude}

if [ "${1:-}" = --setup ]; then
  mkdir -p "$agents" "$main/sessions" || exit 1
  # The global working agreements apply to agents too; the main folder's
  # settings, plugins and skills do not (work plugins would only add tool lists
  # to every agent's context).
  [ -e "$agents/CLAUDE.md" ] || [ ! -e "$main/CLAUDE.md" ] || ln -s "$main/CLAUDE.md" "$agents/CLAUDE.md"
  [ -e "$agents/settings.json" ] || printf '{\n  "env": {"CLAUDE_CODE_FORK_SUBAGENT": "0"},\n  "theme": "auto"\n}\n' >"$agents/settings.json"
  if [ ! -L "$agents/sessions" ]; then
    # A real folder holds registrations of running sessions: moving them while
    # those run is unsafe, so stop them first and remove it by hand.
    if [ -d "$agents/sessions" ] && [ -n "$(ls -A "$agents/sessions")" ]; then
      echo "claude-agents: $agents/sessions is a folder with files; stop that account's sessions, remove it, run --setup again" >&2
      exit 2
    fi
    rmdir "$agents/sessions" 2>/dev/null
    ln -s "$main/sessions" "$agents/sessions" || exit 1
  fi
  echo "claude-agents: $agents ready; sign in once: CLAUDE_CONFIG_DIR=$agents claude"
  exit 0
fi

if [ "$(readlink "$agents/sessions" 2>/dev/null)" != "$main/sessions" ]; then
  echo "claude-agents: $agents/sessions is not a link to $main/sessions; run claude-agents.sh --setup" >&2
  exit 2
fi
CLAUDE_CONFIG_DIR=$agents exec "$bin" "$@"
