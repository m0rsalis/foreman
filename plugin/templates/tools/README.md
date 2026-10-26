# {{TOOLS}}

Installed by the ops kit (`/ops-kit:init`). Edit freely: a rerun of the init never overwrites a file you changed (it leaves the new version in `tmp/ops/init-pending/` and says so).

| File | What |
|---|---|
| `queue.sh <lock> <command...>` | Runs the command holding a shared lock, first come first served across every session and worktree. Locks and their time limits: `locks` in `.claude/ops-kit.json`. A job over its limit is killed with its process group (exit 124); `QUEUE_TIMEOUT_MIN` overrides the limit. Stale locks (dead owner, no owner file, far over the limit) clear themselves. |
| `queue_lock.py`, `queue_run.py` | The atomic lock folder operations and the timed runner behind `queue.sh`. |
| `fullcheck.sh` | The full check through the queue (`fullCheck` or `checkCommand` in the config). Prints one final `FULLCHECK: all green at <sha>` line (or names the failed part) and appends a line to `tmp/ops/checks.jsonl` for the Ops panel. A step with a `cache` entry in `fullCheck` is skipped when its inputs are unchanged since a green run of the same commit contents (`cached` in the output); the line says when HEAD or the tree moved during the run. |
| `suite_cache.py`, `steps_json.sh` | The cache behind `fullcheck.sh`: `fingerprint`, `hit`, `record`, `lint` (do the excluded paths still exist). It lives in the main checkout's `tmp/ops/suite-cache/`. `FORCE_ALL=1` ignores it for one run. A step printing `ops-kit: no-cache` is not recorded. |
| `main_fullcheck.sh` | A forced full check of `origin/<mainBranch>` in a detached worktree (`.claude/worktrees/main-check`), one at a time, log in `tmp/logs/main-check.log`. |
| `needs_lead.py` | What the heartbeat runs: prints nothing when no agent needs the lead (an agent finished, stalled or stopped, a free slot with a ready brief, a red main check, a lane short of briefs); otherwise one line per thing. |
| `quiet.sh <name> <command...>` | Runs a command with its output in `tmp/logs/<name>.log` and prints only the exit code, the error-looking lines and the last 15 lines. |
| `claude-agents.sh` | Optional (`agentsAccount`): `claude` on the second account background agents run on. `--setup` once, sign in once. |
| `statusline.py`, `usage_write.py`, `usage_show.py` | Optional (`usage`): the status line records each account's rate limits in `tmp/ops/usage/`; the panel and `usage_show.py` read them. |
| `run_action.sh` | Runs the Ops panel's action button (`action` in the config), detached, with its state in `tmp/ops/action.json` and its log in `tmp/ops/action.log`. |
| `lead_status.py` | The lead's one-screen restore summary: agents against live sessions (both accounts), lanes against their caps with ready-brief counts, backlog in pick order, locks, worktrees, sign-off, open PRs. |
| `ops_config.py` | Reads the config for the scripts above. |
| `heartbeat.md` | How to start the check-in session. |

Locks live in the main checkout's `tmp/agent-locks/` (`locksDir` in the config; the `OPS_AGENT_LOCKS` environment variable wins), as `locks/<name>.lock/` (owner, started, command) and `locks/<name>.queue/<ns>-<pid>` tickets.

Backlog items (`tmp/ops/backlog.json`) take `lane` when `lanes` are configured (`lanes` in `backlog.json` wins over `.claude/ops-kit.json`: `[{"id", "label", "cap", "owns": [paths], "minReady"}]`; `minReady` defaults to 2, and 0 for `flex`). An item naming an unknown lane is shown under `flex`.
