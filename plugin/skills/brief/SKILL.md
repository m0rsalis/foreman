---
name: brief
description: Write a self-contained brief for a background agent in a repo using the ops kit, and mark the backlog item ready. Use when a feature is defined and needs a brief, or the user says write a brief, define it, or get it ready.
---

# Write a brief

A background agent starts with nothing but its brief, `CLAUDE.md` and its agent definition. The brief must stand alone. Write it to `tmp/ops/briefs/<task>.md` in the main checkout (`<task>` is the short name the agent, its worktree and its session will carry).

## Contents, in this order

1. **Header:** backlog id, the lane (when `lanes` are set; its owned paths bound the work), the agent definition and model (`<slug>-engineer` Opus for hard logic, architecture, design docs, complex merges; `<slug>-implementer` Sonnet for well-specified work; `<slug>-checker` Haiku for check-and-merge or waiting jobs), and why that tier.
2. **The owner's words:** quoted, with the date. Then the owner's answers to the questions asked while defining it.
3. **Read first:** the files and docs, in order.
4. **State inherited:** what exists, what earlier PRs did, branches or worktrees to continue from, anything half done.
5. **Build:** what to make, as concrete as the decisions allow. OPEN questions the agent may meet, each with a proposed default it should use and report.
6. **Tests:** what proves it works; each new test must fail without the change.
7. **Git:** branch names, one PR per milestone, the full check (`<toolsDir>/fullcheck.sh`) before each merge, merge only when `git merge-base --is-ancestor origin/<mainBranch> <green sha>` holds, merge order if another PR is close.
8. **Not in scope:** what it must not touch.
9. **Report:** to the lead by name (`lead` in `.claude/ops-kit.json`) by SendMessage only (one message at the merge for a one-stage brief, then stop; otherwise a line per merge), a hand-back line before stopping on a usage limit, a short final report (PRs, evidence, previews for the owner in the main checkout's `tmp/`, open questions).

Machine rules (queues, no GUI windows, kill only own pids, background long commands) are in the agent definitions; do not repeat them unless the task bends one.

## Then

Set the backlog item's `brief` to the path and its status to `ready` (or `defined` if it still waits on the owner). Checkpoint.
