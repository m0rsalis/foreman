---
name: revive
description: Revive a background agent that died, stalled, or ended on a usage limit or API error, in a repo using the ops kit; or hand its work to a fresh agent. Use when an agent card is red, lead_status shows not running or done without a final report, or the user says revive, resume or restart an agent.
---

# Revive an agent

Background sessions end (state `done`) when they hit a usage limit, and can die silently (blocked, no pid). A clear of the lead does not touch them.

1. **Check it is really not running:** `claude agents --json --all` (on the agents' account, `<toolsDir>/claude-agents.sh agents --json --all`; `lead_status.py` lists both). Find it by name; note `state`, `id` and the full `sessionId`. If it is running or busy, do NOT resume: `--resume` on a live session starts a second copy working in the same worktree. Message it by name instead.
2. **Resume with the FULL session id** (a prefix can match the wrong session) and a message naming its worktree, because a resumed session may start in the main checkout:

```bash
claude --bg --resume <full sessionId> "Resumed by the lead. Your worktree is <main checkout>/.claude/worktrees/<task>; work only there. Carry on from where you stopped: <what the record says it was doing>. Run long commands in the background. Report to '<lead>' as before."
```

   It keeps its agent, model and permission mode.
3. **If it hit a usage limit** and the limit has not reset, wait for the next check-in.
4. **Replace instead of resume** when the model should change, the session is broken, or its context is too long: message it (or, if dead, read its worktree and log) for a hand-back (what is done, what remains, anything non-obvious), write that into a new brief, and start a fresh agent in the same worktree (`/ops-kit:start-agent`, without `-w`). Then `claude rm` the old session.
5. Update its `step` and `sessionId` in status.json (a resume keeps the id; a replacement gets a new one). Checkpoint.

Never kill an agent's processes by pattern. Never stop a queued job mid-run; its lock outlives it until the queue clears the dead owner.
