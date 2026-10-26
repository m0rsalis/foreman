---
name: init
description: Set this git repository up for the lead-and-agents way of working (backlog, shared locks, background agents with a model per difficulty, the Ops panel). Use when the user asks to install, set up, initialise or update Foreman in a repo, or runs /foreman:init. Safe to run again; it never overwrites a file the user edited without asking.
---

# Set up Foreman in this repo

The engine is `scripts/ops_init.py` in this plugin: from this skill's base directory, `../../scripts/ops_init.py`. It is idempotent and prints one line per file it touched, then `INIT: n created, n updated, n unchanged, n kept`.

## 1. Gather the values (one question round, with defaults)

Run a dry run first to see the defaults it would use and whether the repo already has a config:

```bash
python3 "<base>/../../scripts/ops_init.py" --repo . --dry-run --json
```

From its `config`, propose these and ask the user once (AskUserQuestion, recommended option first), skipping any the existing `.claude/foreman.json` already settles unless the user asked to change them:

| Value | Flag | Default |
|---|---|---|
| Owner: whose decisions the lead waits for (a first name) | `--owner` | git `user.name`, first word |
| Lead session name: what agents SendMessage to | `--lead` | `<slug>-lead` |
| Agent cap: background agents at once | `--cap` | 4 |
| Full check command | `--check` | detected (`make check`, `npm test`, `cargo test`, ...) |
| Shared locks with minutes before a job is killed | `--locks check:120,sim:45` | `check:120` |
| Agent name prefix | `--slug` | the folder name |
| Second Claude account for background agents (their usage limit is then not the lead's; needs a one-time sign-in) | `--agents-account` / `--no-agents-account` | off |
| Lanes: parallel areas with an agent cap and the paths each owns, as `id[:cap[:path+path]]`, comma separated; a lane named `flex` takes whatever fits no other | `--lanes core:2:src+docs,flex:1` | none |
| Usage gauge in the panel and a status line that feeds it (per account) | `--usage` / `--no-usage` | off |
| Main branch and whether to check it forced (`main_fullcheck.sh`) | `--main-branch`, `--main-check` / `--no-main-check` | detected, on |

The lead's session name matters: background agents reach the lead only by it. In the terminal start the lead with `claude --name <lead>`; in the desktop app, rename the session to it.

## 2. Run it

```bash
python3 "<base>/../../scripts/ops_init.py" --repo . --owner <o> --lead <l> --cap <n> --check "<cmd>" --locks <spec>
```

Show the user the lines it printed. For each `kept` line (a file the user edited, or one that existed before the kit), show the diff between the file and `tmp/ops/init-pending/<path>` and ask whether to take the kit's version; rerun with `--force <path>` for those the user accepts (`--force CLAUDE.md` for the CLAUDE.md section). Never force a file without asking.

## 3. Finish

- Multi-step checks (several commands, different locks) go in `.claude/foreman.json` as `fullCheck`: `[{"part": "check", "lock": "check", "command": "make check"}, {"part": "e2e", "lock": "sim", "command": "make e2e"}]`. A step skips itself when its inputs are unchanged if it has `"cache": {"exclude": ["docs"], "keep": [], "fingerprint": []}` (`exclude` paths that cannot change its result, `keep` paths inside them that can, `fingerprint` commands whose output is an input too); `checkCache` (`toolchain` paths, `machine` commands) applies to every cached step. Run `python3 <tools>/suite_cache.py lint` to check the paths exist. A step that prints `foreman: no-cache` is never recorded. Other settings there: `previews` (folders whose newest files the panel lists), `action` (`{"label": "Deploy", "command": "...", "confirm": "..."}`, a button on the panel), `decisionLog` and `reviewNotesDir` (docs the panel scans for open questions), `stallMinutes`, `autoOpen`. Rerun the init after changing `owner`, `lead`, `slug`, `locks` or the check, so the CLAUDE.md section and agent files follow.
- Commit the tracked files on a branch (`.claude/foreman.json`, `.claude/foreman-files.json`, `.claude/agents/`, the tools folder, `CLAUDE.md`, `.gitignore`) if the user wants them shared; `tmp/` and `.claude/settings.local.json` stay local.
- Offer to start the heartbeat with the command in `<tools>/heartbeat.md` (it needs the lead's session name to be right first).
- Tell the user: `/ops` opens the panel; `/foreman:restore` is the lead's first step in a new session.
