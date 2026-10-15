---
name: start-agent
description: Start a background agent for a ready backlog item in a repo using the ops kit, with the exact claude --bg command, and record it. Use when a slot is free and an item is ready, or the user says start, launch or spin up an agent.
---

# Start an agent

1. **Slot:** agents in `tmp/ops/status.json` < `agentLimit`. If full, do not start; say which item is next.
2. **Pick:** the first ready item in pick order (`lead_status.py` marks it NEXT): the owner's priority, then rank, dependencies done, not blocked. When unsure between two, ask the owner with a recommendation.
3. **Brief:** `tmp/ops/briefs/<task>.md` exists and is self-contained (`/ops-kit:brief`).
4. **Start it from the main checkout** (settings from `.claude/ops-kit.json`: `slug`, `lead`, `heartbeatName`):

```bash
claude --bg -w <task> --agent <slug>-<tier> --permission-mode auto --name <task> "Your brief is <main checkout>/tmp/ops/briefs/<task>.md: read it first and follow it. tmp/ paths mean the main checkout's tmp/ (<main checkout>/tmp). Work only in your worktree. Report to the lead's session '<lead>' by SendMessage only: one line per merge, a hand-back line before stopping on a usage limit, then the final report. If the lead is unreachable, send it to '<heartbeatName>' and carry on. Run long commands in the background. No sub-agents."
```

   - `<tier>`: `engineer` (Opus), `implementer` (Sonnet), `checker` (Haiku), as the brief says.
   - Work outside this repo: add `--add-dir <path>`. A test session: add `--model haiku` and a one-line job; stop and remove it yourself after.
   - Continuing in an existing worktree instead of a new one: drop `-w`, and say in the message "Your worktree is <path>; work only there".
5. **Record:** `claude agents --json --all` gives the new session's `id` and `sessionId`. Add the agent to status.json (`kind: "bg"`, `sessionName`, the full `sessionId`, `model`, `agent`, `worktree`, `branch`, `step`, `startedAt`, `backlog`), set the backlog item `in_progress` with `agent`. Checkpoint.

The panel shows the card within seconds (green running, amber stalled, red stopped).
