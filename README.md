# Foreman

A way of working with Claude Code where one **lead** session plans, delegates and merges while **background agents** build, each in its own worktree, on the model the job needs. The kit packages it for any git repo: the rules Claude follows, the agent definitions, a shared queue so agents never fight over one machine resource, a backlog the lead picks from, routines as skills, and the **Ops panel** that shows all of it beside the conversation.

It came out of a long project run this way (about twenty merged PRs a day with up to four agents in parallel) and is written to be applied to any other repo or handed to someone else.

## What you get

| Part | What it does |
|---|---|
| **Ops panel** (`/ops`) | A pane in Claude Code: agent slots and cards (model badge, step, running, stalled or stopped), the shared locks with who holds and who waits, the backlog in pick order with the next item marked, what waits for the owner (decisions, reviews, tests, concepts, actions), full-check history per branch, open and merged PRs, an optional action button (deploy, release, report), the newest previews, and a heartbeat indicator. |
| **`/foreman:init`** | Sets a repo up: the CLAUDE.md rules, three agent tiers in `.claude/agents/`, the queue and check scripts, the lead's state files in `tmp/ops/`, `.gitignore` entries and the permission entries background agents need. Idempotent; never overwrites a file you edited without asking. |
| **Lead routines** (skills) | `/foreman:restore`, `/foreman:checkpoint`, `/foreman:check-in`, `/foreman:brief`, `/foreman:start-agent`, `/foreman:revive`, `/foreman:merge`. The lead follows them without being told. |
| **Queue** (`tools/foreman/queue.sh <lock> <cmd>`) | FIFO locks shared by every session and worktree for anything there is one of (a test database, a simulator, the full check). Time limits that kill the whole job, stale locks that clear themselves, no overlap even when two waiters race. |
| **Full check** (`tools/foreman/fullcheck.sh`) | Your check command(s) through the queue, one final `FULLCHECK:` line, a history line for the panel. Agents merge only on green. |
| **Heartbeat** | A tiny Haiku background session that runs `needs_lead.py` every 30 minutes and messages the lead only when something needs it (an agent finished, stalled or stopped, a free slot with a ready brief, a red main check, a lane short of briefs), so agents stopped by a usage limit are revived and free slots are filled while you are away. |
| **Suite cache** | A `fullCheck` step with a `cache` entry is skipped when its inputs did not change since a green run, so a docs-only PR does not rerun the test suite. `main_fullcheck.sh` checks `origin/main` forced, in its own worktree. |
| **Lanes** (optional) | Parallel areas with their own agent cap and owned paths; the panel and `lead_status.py` show each against its cap and warn when too few briefs are ready. |
| **Second account and usage** (optional) | Background agents on a second Claude account (`claude-agents.sh`) so their usage limit is not the lead's; a status line records each account's limits and the panel shows them as gauges. |
| **`quiet.sh`** | Runs a long command with its output in a log and prints only the failing lines and the tail. |

### Why it works

- **Background sessions** (`claude --bg`) survive the lead's context clears and run in their own worktrees, so a clear or a crash of the lead loses nothing.
- **The record is files, not the conversation**: `tmp/ops/status.json`, `backlog.json`, `lead-notes.md`, briefs and reports. Any fresh lead session restores from them in a minute.
- **Model per difficulty**: Opus for the hard parts, Sonnet for well-specified work, Haiku for checking, merging and waiting. Cheaper and faster than one model for everything.
- **One queue for shared resources** and a **merge order**: parallel agents stop starving each other.

## Requirements

- **Claude Code 2.1.287 or newer** (`claude --version`; `claude update`). The panel is a Claude Code mod (function hooks); background sessions need `claude --bg`. The desktop app ships its own Claude Code; the panel shows in the right-hand pane of its Code tab, or beside the conversation in a terminal 144 columns or wider (fullscreen), otherwise above the prompt.
- **The CLI signed in**: `claude auth login` (the desktop app's login does not cover the `claude` command the lead uses to start agents).
- **git**, **gh** (signed in, for PRs and the panel's PR list), **python3** (3.9+).
- **macOS** is what it runs on today (the panel uses BSD `stat` and `lsof`; the queue and init run anywhere with bash and Python).
- For the kit's own tests: Node 22.6 or newer, shellcheck.

## Install

The repository is private: you need read access to `m0rsalis/foreman` and `gh auth login` (or git credentials) that can fetch it.

In a shell, inside the repo you want to run this way:

```bash
cd ~/code/your-repo
claude plugin marketplace add m0rsalis/foreman --scope local
claude plugin install foreman@foreman --scope local
```

If the add fails with "Could not read from remote repository" or "unable to get password", git is fetching as another GitHub account (for example a global `credential.https://github.com.username`). Name the account in the URL so the stored credential for it is used: `claude plugin marketplace add https://<your-account>@github.com/m0rsalis/foreman.git --scope local` (`gh auth setup-git` stores one for the account `gh` is signed in as).

`--scope local` keeps it to this repo (entries in its gitignored `.claude/settings.local.json`); use `--scope user` to have it in every repo. Or, at the prompt of a session in the repo: `/plugin install foreman --marketplace m0rsalis/foreman`.

Then start a new session in the repo (or `/reload-plugins` in an open one) and run:

```
/foreman:init
```

It asks once for the owner's name, the lead session's name, the agent cap, the full-check command and the shared locks (with defaults it detects), and whether you want a second account for agents, lanes (with the paths each owns), the usage gauge and a forced check of main, writes the files, and tells you what it did. Then:

1. **Name the lead session** what you told the init (terminal: `claude --name <lead>`; desktop: rename the session). Agents reach the lead only by that name.
2. **Start the heartbeat** with the command in `tools/foreman/heartbeat.md` (the init offers to).
3. **Commit** the shared files on a branch if your team uses them: `.claude/foreman.json`, `.claude/foreman-files.json`, `.claude/agents/`, `tools/foreman/`, `CLAUDE.md`, `.gitignore`. The state in `tmp/` and `.claude/settings.local.json` stay on your machine.

`/ops` opens the panel; it also opens by itself when a session starts (`autoOpen`).

### What the init writes

| Where | What | On a rerun |
|---|---|---|
| `.claude/foreman.json` | Settings (below) | Only the keys you pass as flags change |
| `.claude/agents/<slug>-engineer.md`, `-implementer.md`, `-checker.md` | Opus, Sonnet, Haiku agent definitions | Updated if untouched, kept if you edited them |
| `tools/foreman/` | `queue.sh`, `queue_lock.py`, `queue_run.py`, `fullcheck.sh`, `suite_cache.py`, `steps_json.sh`, `main_fullcheck.sh`, `run_action.sh`, `lead_status.py`, `needs_lead.py`, `quiet.sh`, `claude-agents.sh`, `statusline.py`, `usage_write.py`, `usage_show.py`, `ops_config.py`, `heartbeat.md`, `README.md` | Same |
| `CLAUDE.md` | The rules, between `<!-- foreman:begin -->` and `<!-- foreman:end -->`; the rest of the file is yours | The section: same |
| `.claude/foreman-files.json` | What the init wrote last (how it knows what you edited) | Kept in step |
| `tmp/ops/` (main checkout) | `status.json`, `backlog.json`, `lead-notes.md`, `briefs/`, `reports/` | Never rewritten |
| `.gitignore` | `/tmp/ops/`, `/tmp/agent-locks/`, `/tmp/logs/`, `/.claude/settings.local.json`, `/.claude/worktrees/` unless already ignored | Added once |
| `.claude/settings.json` | Only keys that are missing: `autoCompactWindow`, `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and with `--usage` the `statusLine` | Missing keys added; yours kept |
| `.claude/settings.local.json` (main checkout) | Permission entries: `claude --bg`, `claude agents/logs/stop/rm`, `SendMessage`, git fetch/pull/push/switch/checkout/branch/merge/worktree, `gh pr create/merge/view/list`, the queue, check and status scripts | Missing entries added; nothing removed; hooks untouched |

A file you edited is never overwritten: the kit's new version goes to `tmp/ops/init-pending/<path>` and the init says so; the skill shows you the diff and asks. `--force <path>` takes the kit's version.

Note that the permission entries let agents push branches and merge PRs without asking each time. That is the point (agents merge their own PRs on a green full check), but read the list before you accept it, and drop `Bash(git push:*)` or `Bash(gh pr merge:*)` if you want to merge by hand.

## Settings: `.claude/foreman.json`

Shared (commit it). `tmp/ops/config.json`, if present, overrides any key on this machine only (for example `gh` or a `previews` folder outside the repo).

| Key | Default | Meaning |
|---|---|---|
| `owner` | your git first name | Whose decisions the lead waits for: "Waiting for <owner>" |
| `lead` | `<slug>-lead` | The lead session's name; agents and the heartbeat message it |
| `slug` | the folder name | Prefix of the agent definitions (`<slug>-engineer`) |
| `project` | the folder name | The project's name in the agent definitions |
| `agentCap` | 4 | Agent slots; `agentLimit` in `status.json` wins when the lead sets it (the owner changes it with the usage limits) |
| `checkCommand` | detected (`make check`, `npm test`, `cargo test`, `go test ./...`, pytest) | The full check, run under the `check` lock |
| `fullCheck` | none | Several steps instead: `[{"part": "unit", "lock": "check", "command": "make test"}, {"part": "e2e", "lock": "sim", "command": "make e2e"}]` (`lock: null` runs without the queue) |
| `locks` | `[{"name": "check", "timeoutMin": 120}]` | The shared locks and the minutes after which a job is killed |
| `toolsDir` | `tools/foreman` | Where the scripts live |
| `locksDir` | `tmp/agent-locks` | The lock folder in the main checkout (`OPS_AGENT_LOCKS` overrides) |
| `heartbeatName` | `<slug>-heartbeat` | The check-in session's name |
| `previews` | `["tmp/previews"]` | Folders whose three newest files the panel lists |
| `action` | none | A panel button: `{"label": "Deploy staging", "command": "make deploy", "confirm": "Deploy main to staging?"}`; runs detached in the main checkout, state and log in `tmp/ops/action.*` |
| `decisionLog` | none | A Markdown file with a "Decision log" table; rows with status Proposed show as decisions waiting |
| `reviewNotesDir` | none | A folder with `review-notes-YYYY-MM-DD.md`; open items after the latest answers show as reviews waiting |
| `signoffKinds` | `decision, review, test, concept, action` | The panel's tiles; other kinds count under the last |
| `stallMinutes`, `refreshSeconds`, `autoOpen`, `gh` | 20, 5, true, `gh` | Panel behaviour |
| `fullCheck[].cache` | none (step always runs) | `{"exclude": [paths], "keep": [paths], "fingerprint": [commands]}`: paths whose changes cannot change the step's result, paths inside them that can, commands whose output is an input too |
| `checkCache` | none | `{"toolchain": [paths], "machine": [commands]}` added to every cached step's inputs (the tools folder, this config and `.gitignore` are always included) |
| `mainBranch`, `mainCheck` | detected from `origin/HEAD`, true | The branch the forced main check runs on; whether `needs_lead.py` watches it |
| `lanes` | none | `[{"id", "label", "cap", "owns": [paths], "minReady"}]`; `lanes` in `tmp/ops/backlog.json` wins. `minReady` defaults to 2 (0 for `flex`) |
| `agentsAccount`, `claude`, `accounts` | false, `claude`, none | Background agents on a second account (`tools/foreman/claude-agents.sh`); the `claude` command to use |
| `usage`, `autoCompactWindow` | false, 300000 | The usage gauges and their status line; the auto-compact window written to `.claude/settings.json` |

Rerun `/foreman:init` after changing `owner`, `lead`, `slug`, `locks` or the check, so the CLAUDE.md section and the agent files follow.

## A day in the life

1. **The owner describes a feature** in the lead session. The lead asks what it needs to know (one theme at a time, each question with a recommendation) and writes the item into `tmp/ops/backlog.json`: status `defined`, a rank, dependencies.
2. **The lead writes the brief** (`/foreman:brief`): the owner's words, files to read, state inherited, what to build, tests, branch, report format. The item turns `ready`. The panel shows it with a `next` chip when it is first in line.
3. **A slot opens** (agents under the cap): the lead picks the best ready item (the owner's priority beats the lead's rank; dependencies done) and starts an agent (`/foreman:start-agent`): `claude --bg -w <task> --agent <slug>-engineer ...`. A card appears on the panel.
4. **The agent builds** in its worktree, runs `fullcheck.sh` (queued behind the others), merges on green and messages the lead one line per merge. Things only the owner can judge (a look, a decision) go into `status.json` as sign-off items and show under "Waiting for <owner>".
5. **The lead merges and cleans up** (`/foreman:merge`): files the report, marks the item done, stops and removes the session and its worktree, deletes the branch, fills the slot.
6. **Every 30 minutes the heartbeat checks in** (`/foreman:check-in`): revives agents a usage limit stopped, nudges stalled ones, fills free slots. At every change the lead checkpoints (`/foreman:checkpoint`) so a fresh session can restore (`/foreman:restore`).

## Share it

The repo is private. To give someone the kit:

- **Repo access:** add them as a collaborator (`gh api -X PUT repos/m0rsalis/foreman/collaborators/<their-github-name> -f permission=pull`, or GitHub's Settings, Collaborators). They then follow Install above.
- **Or a copy:** they can add a local folder as the marketplace: `claude plugin marketplace add /path/to/foreman --scope local`.

## Upgrading from ops-kit (before 0.3.0)

Until 0.3.0 the kit was called ops-kit (repo `m0rsalis/claude-ops-kit`, plugin `ops-kit@claude-ops-kit`, tools in `tools/ops-kit/`). Swap the plugin, then run `/foreman:init` in the repo:

```bash
claude plugin uninstall ops-kit@claude-ops-kit --scope local
claude plugin marketplace remove claude-ops-kit
claude plugin marketplace add m0rsalis/foreman --scope local
claude plugin install foreman@foreman --scope local
```

The init's first run adopts the old setup in place: `.claude/ops-kit.json` and `.claude/ops-kit-files.json` become `.claude/foreman.json` and `.claude/foreman-files.json`, `tools/ops-kit/` moves to `tools/foreman/` (a custom `toolsDir` stays where it is), and the CLAUDE.md markers are renamed, so a file you edited is still recognised as edited. The `tools/ops-kit` permission entries in `.claude/settings.local.json` stay beside the new ones (the init never removes entries); delete them by hand. Sessions that call `tools/ops-kit/` paths need a restart, the heartbeat above all: start a new one from `tools/foreman/heartbeat.md` and stop the old one.

From the 2026-10-15 kit the same run also brings what changed since: Files the old init wrote and you did not edit are updated (`fullcheck.sh`, `queue.sh`, `lead_status.py`, `ops_config.py`, `heartbeat.md`, the agent tiers, the CLAUDE.md section); the new tools (`needs_lead.py`, `quiet.sh`, `suite_cache.py`, `steps_json.sh`, `main_fullcheck.sh`) are created; files you edited are kept and the new version waits in `tmp/ops/init-pending/` (`--force <path>` takes it). Nothing in `tmp/ops/` is rewritten. New settings default off (`agentsAccount`, `lanes`, `usage`) except the forced main check, which `needs_lead.py` uses; add them with the init's flags. A multi-step `fullCheck` keeps running every step until you add a `cache` entry to the steps whose inputs you can name.

## Update

```bash
claude plugin marketplace update foreman
claude plugin update foreman@foreman --scope local
```

Then `/reload-plugins` (or a new session) and `/foreman:init` again to take new versions of the scripts and rules (files you edited are kept and the new versions shown).

## Uninstall

```bash
claude plugin uninstall foreman@foreman --scope local
claude plugin marketplace remove foreman
```

The init's files stay in the repo (they are yours). To remove them too: `tools/foreman/`, `.claude/agents/<slug>-*.md`, `.claude/foreman.json`, `.claude/foreman-files.json`, the CLAUDE.md section between the foreman markers, `tmp/ops/` and `tmp/agent-locks/`, the `.gitignore` lines, and the permission entries in `.claude/settings.local.json`. Stop the heartbeat (`claude agents --json --all`, `claude stop <id>`, `claude rm <id>`).

## Develop the kit

```bash
make check      # lint, type check, every test
make test-panel # the panel's readers and drawing (fast)
make preview REPO=~/code/your-repo   # print the pane as text from a real repo
```

| Path | What |
|---|---|
| `.claude-plugin/marketplace.json` | The marketplace (`foreman`) holding the plugin |
| `plugin/hooks/` | The panel: `register.ts` (events, actions), `data.ts` (readers), `view.ts` (the pane) |
| `plugin/types/index.d.ts` | The snapshot and state contract |
| `plugin/skills/` | `init` and the lead routines |
| `plugin/scripts/ops_init.py` | The init engine |
| `plugin/templates/` | What the init writes: rules, agent tiers, tools, state |
| `plugin/tests/panel.test.ts` | The pane through Claude Code's plugin test kit (`claude plugin test plugin`) |
| `test/` | Node tests of the readers and pane, shell tests of the queue, init and tools, lint, type check, the text preview |

Bump `version` in `plugin/.claude-plugin/plugin.json` with every change to the plugin, or `claude plugin update` will not pick it up.
