---
name: check-in
description: The lead's periodic check-in for a repo using the ops kit - revive agents stopped by a usage limit or an error, nudge stalled ones, fill free slots from the backlog, merge housekeeping. Use when a message says "check-in (heartbeat)" or the user asks for a check-in.
---

# Check-in

The heartbeat session sends "check-in (heartbeat)" at :17 and :47. Keep it short; if nothing needs doing, reply in one line and end the turn.

1. `python3 <toolsDir>/needs_lead.py`: it prints nothing when no agent needs the lead, and that is the whole check-in. Otherwise run `python3 <toolsDir>/lead_status.py` (toolsDir from `.claude/ops-kit.json`): with lanes it shows each lane against its cap, `OVER`, and `LOW` when too few briefs are ready.
2. **Dead or stopped agents** (in status.json, session not running or state `done` without a final report): revive with `/ops-kit:revive`. A usage limit ends a session; after the reset a resume continues it.
3. **Stalled agents** (the panel's amber card, quiet for `stallMinutes`): message by name: run long commands in the background, report where you are.
4. **Reports** that arrived: file them in `tmp/ops/reports/<task>.md`; for merges run `/ops-kit:merge` clean-up.
5. **Briefs low**: a `LOW` lane or a `briefs low` / `pipeline empty` alert means write briefs (`/ops-kit:brief`) for defined items of that lane, or tell the owner there is nothing left to define.
6. **Free slots**: if agents < `agentLimit`, start the next ready backlog item (`/ops-kit:start-agent`). The owner's `priority` beats `rank`; dependencies must be done; prefer work related to what is running. If the owner said priority one for something, do only that.
7. **Locks**: a lock held far past its limit with a dead owner clears itself at the next waiter; never kill a queued job yourself.
8. **Disk**: worktrees of merged branches go (`/ops-kit:merge`, the clean-up part).
9. Checkpoint if anything changed (`/ops-kit:checkpoint`).
