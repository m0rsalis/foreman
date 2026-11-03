---
name: merge
description: Merge an agent's PR in the right order and clean up after it (stop and remove the session, remove the worktree, delete merged branches) in a repo using Foreman. Use when an agent reports a PR ready or merged, when two PRs are close, or the user says merge or clean up.
---

# Merge and clean up

## Merge order
- When two or more PRs are close, announce an order to their agents (by message): `#A, then #B`. Each merges `origin/main` and starts its full check only after the one ahead is on main. Two checks racing for the same main starve each other and both go stale.
- A PR merges only on a clean green from `<toolsDir>/fullcheck.sh`: the last line of the check's log passes `tail -n 1 <log> | grep -Eq '^FULLCHECK: all green at [0-9a-f]+ \([0-9]+ of [0-9]+ steps cached\)$'` (the other lines that start `FULLCHECK: all green at` are not clean: `+ uncommitted changes`, `, but HEAD is now <sha>` and `, but the working tree changed during the run` each covered something other than that commit), and its `<sha>` is the branch head and the PR's head (`[ "$(gh pr view <n> --json headRefOid --jq .headRefOid)" = "$(git rev-parse <sha>)" ]` succeeds: the line abbreviates the sha and `headRefOid` is all 40 characters, so the test expands `<sha>`; never compare the two strings), and `git fetch origin` immediately before `git merge-base --is-ancestor origin/<mainBranch> <sha>` shows it holds; if it does not, main moved: merge it in and recheck. `cached` steps are fine: the inputs did not change. The merge is `gh pr merge <n> --<mergeMethod>` (`.claude/foreman.json`, default `merge`). Who merges is `mergeBy`: with `agent` (the default) agents merge their own PRs, and a `<slug>-checker` can rerun the check and merge for one that stopped; with `lead` an agent reports its PR ready and stops, and the lead merges it (after any review the repo requires).
- PRs the owner must approve first (mockups, concepts, anything the brief says) are not merged until the owner says so; add a sign-off item.
- Never force-push main.

## After a merge
1. File the agent's report (`tmp/ops/reports/<task>.md`), set the backlog item `done` with its `pr`.
2. If the agent has more work in its brief, leave it running. When it is finished:
   - Copy the previews its report names from `<worktree>/tmp/previews/` into the main checkout's preview folder (the first of `previews` in `.claude/foreman.json`, default `tmp/previews`). Removing the worktree deletes them, and the agent's sandbox could not write the main checkout.
   - `claude stop <id>`, then `claude rm <id>` (with a second account for agents: `<toolsDir>/claude-agents.sh stop <id>` and `rm <id>`) (it removes the worktree when that is safe).
   - `claude rm` refuses while the worktree has untracked files: list them (`git -C <worktree> status --porcelain --ignored`), check anything the owner needs is saved (previews copied as above), delete the rest, and `claude rm` again. Never `git worktree remove --force` work you have not looked at.
   - `git worktree prune`, `git fetch --prune`, then delete the branches. How depends on `mergeMethod` (`.claude/foreman.json`, default `merge`):
     - `merge`: `git branch -d <branch>`.
     - `squash` or `rebase`: `git branch -D <branch>`, only after `gh pr view <n> --json state,mergedAt` shows `state` `MERGED` and a `mergedAt` that is not null. These merges put new commits on main, so the branch is never their ancestor and `-d` always refuses ("not fully merged"). Never decide on ancestry, and keep the branch of a `CLOSED` PR: it may hold the only copy of the work.
     - `git branch -d worktree-<task>` for every method (the branch `-w` created; when it is also the PR branch, the line above applies to it). If `-d` refuses, it holds commits that are not on main: look at them (`git log origin/<mainBranch>..worktree-<task>`) before forcing.
   - Worktrees can hold gigabytes of dependencies and caches each; a dozen left behind fill a disk.
3. Never push to a branch after its PR merged; start a new branch from main.
4. Remove the agent from status.json; the slot is free: start the next item (`/foreman:start-agent`). Checkpoint.
