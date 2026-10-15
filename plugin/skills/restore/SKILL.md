---
name: restore
description: The lead session's start-up and after-a-clear routine for a repo using the ops kit - read the record, compare it with what is live, act on reports, revive dead agents, carry on. Use at the start of a lead session, after a context clear, or when the user says restore, catch up or where are we.
---

# Restore the lead

The conversation is not the record; files are. Paths are in the main checkout. Settings: `.claude/ops-kit.json` (`owner`, `lead`, `toolsDir`, `heartbeatName`).

1. Read `tmp/ops/lead-notes.md` and the CLAUDE.md section "Working with parallel agents".
2. Run `python3 <toolsDir>/lead_status.py`. It prints the agents from `tmp/ops/status.json` against the live background sessions, the reports in `tmp/ops/reports/`, the backlog in pick order (with NEXT), the locks, worktrees, sign-off items and open PRs.
3. If the heartbeat is not running, start it with the command in `<toolsDir>/heartbeat.md` (only when this session's name is the configured `lead`).
4. Read every report not yet acted on (the lead notes say which were). Merged work: update the backlog item to `done`, run the merge clean-up (`/ops-kit:merge`).
5. For each agent in status.json:
   - running: leave it alone; message it by name only if it needs something.
   - state `done` or `stopped` without a final report, or not running at all: revive it (`/ops-kit:revive`).
   - stalled (no file change for `stallMinutes`): message it by name telling it to run long commands in the background.
6. Free slots (agents under `agentLimit`): start the best ready backlog item from its brief (`/ops-kit:start-agent`).
7. Tell the owner in a few lines where things stand and what waits for them. Then checkpoint (`/ops-kit:checkpoint`).

Never clear yourself. Never resume a running session (that starts a copy).
