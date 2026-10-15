# {{TOOLS}}

Installed by the ops kit (`/ops-kit:init`). Edit freely: a rerun of the init never overwrites a file you changed (it leaves the new version in `tmp/ops/init-pending/` and says so).

| File | What |
|---|---|
| `queue.sh <lock> <command...>` | Runs the command holding a shared lock, first come first served across every session and worktree. Locks and their time limits: `locks` in `.claude/ops-kit.json`. A job over its limit is killed with its process group (exit 124); `QUEUE_TIMEOUT_MIN` overrides the limit. Stale locks (dead owner, no owner file, far over the limit) clear themselves. |
| `queue_lock.py`, `queue_run.py` | The atomic lock folder operations and the timed runner behind `queue.sh`. |
| `fullcheck.sh` | The full check through the queue (`fullCheck` or `checkCommand` in the config). Prints one final `FULLCHECK:` line and appends a line to `tmp/ops/checks.jsonl` for the Ops panel. |
| `run_action.sh` | Runs the Ops panel's action button (`action` in the config), detached, with its state in `tmp/ops/action.json` and its log in `tmp/ops/action.log`. |
| `lead_status.py` | The lead's one-screen restore summary: agents against live sessions, backlog in pick order, locks, worktrees, sign-off, open PRs. |
| `ops_config.py` | Reads the config for the scripts above. |
| `heartbeat.md` | How to start the check-in session. |

Locks live in the main checkout's `tmp/agent-locks/` (`locksDir` in the config; the `OPS_AGENT_LOCKS` environment variable wins), as `locks/<name>.lock/` (owner, started, command) and `locks/<name>.queue/<ns>-<pid>` tickets.
