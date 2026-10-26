---
name: checkpoint
description: Write the lead's record for a repo using Foreman - status.json, backlog.json, lead-notes.md, briefs, decisions. Use whenever an agent starts, hands back or merges, before a clear, or when the user says checkpoint or save state.
---

# Checkpoint

Everything lives in the main checkout's `tmp/ops/` (gitignored). Write JSON with a tool that keeps it valid (read, change, write the whole file; check it parses).

1. **`tmp/ops/status.json`** (schema 1): `updated` (now, ISO UTC), `agentLimit` (the owner's current cap), `priority` (one line: today's focus or the owner's latest instruction, or null), `agents[]`, `signoff[]`.
   - An agent: `name`, `kind` (`bg`), `sessionName`, `sessionId` (the FULL id, for a revive), `model` (`opus`, `sonnet`, `haiku`), `agent` (the definition name), `worktree` (relative, `.claude/worktrees/<task>`), `branch` (several as `a / b`), `step` (one line: what it is doing now), `next` (or null), `startedAt`, `backlog` (the item id).
   - A sign-off item: `item` (what the owner must do), `kind` (`decision`, `review`, `test`, `concept`, `action`, or the kinds in `signoffKinds`), `where` (comma separated; repo paths become links), `since` (ISO time or date).
2. **`tmp/ops/backlog.json`**: each item's `status` (`inbox`, `defined`, `ready`, `in_progress`, `review`, `blocked`, `done`), `agent`, `pr`, `rank`, `blockedBy`; `updated`. Never change an owner's `priority` on your own.
3. **Briefs**: every item marked `ready` has its self-contained brief in `tmp/ops/briefs/<task>.md` (`/foreman:brief`).
4. **Reports**: file each agent report received by message as `tmp/ops/reports/<task>.md`.
5. **`tmp/ops/lead-notes.md`**: overwrite, about a page: Now (cap, running agents, merge order, what is in flight), the owner's directions not yet built, open questions for the owner (grouped by theme, asked one theme at a time), non-obvious know-how, kept worktrees and why, session ids to resume.
6. **Decisions** the owner made since the last checkpoint go into the repo's docs in a small PR (the design doc's OPEN table, a review-notes file), not only into the notes.

Then one line to the owner: what changed.
