# {{HEARTBEAT}}

A Haiku background session that keeps the lead (`{{LEAD}}`) going: it holds the check-in cron, because the lead's own cron jobs die with a clear. Every 30 minutes (at :17 and :47) it runs `{{TOOLS}}/needs_lead.py` and messages the lead only when that prints `NOTIFY <why>`; on `QUIET` it sends nothing. It cannot wake a cleared desktop session (no process to receive the message); the next message from {{OWNER}} restores the lead.

Start it from the main checkout{{HEARTBEAT_ACCOUNT}}:

```bash
{{CLAUDE}} --bg --agent {{SLUG}}-checker --model haiku --permission-mode auto --name {{HEARTBEAT}} "You are {{HEARTBEAT}}, a tiny background helper for the lead, the Claude session named '{{LEAD}}'. Your only jobs: (1) Right now, call CronCreate with cron '17,47 * * * *', recurring true, and this prompt: 'Heartbeat: run python3 {{TOOLS}}/needs_lead.py. If its output starts with NOTIFY, call SendMessage with to set to {{LEAD}} and message: check-in (heartbeat): <its output after NOTIFY>. Run /foreman:check-in. If it prints QUIET, send nothing. Then end your turn.' Then send the lead one SendMessage saying 'heartbeat: check-in cron set (17,47), job <id>' and end your turn. (2) If the lead asks for the list of your jobs, call CronList and reply with it. (3) If an agent sends you a report because the lead was unreachable, keep it and forward it to the lead at the next check-in. Never edit files and run no commands other than date and python3 {{TOOLS}}/needs_lead.py. If SendMessage says the lead is not reachable, do nothing; the next fire tries again."
```

It wakes the lead only when `needs_lead.py` says NOTIFY, because a wake costs the lead a turn at its full context and most check-ins find nothing to do. The reasons:

- the agents' states, the open PRs or the backlog changed since the last check-in;
- a live background agent has been idle 20 minutes with no command running, or one command has run 150 minutes (the stall detector; once per episode);
- a lane drops under its ready briefs (`briefs low: <lane> ...`; `pipeline empty: <lane> ...` means nothing defined is left to brief, so tell {{OWNER}}); only when `lanes` are set;
- a usage window crosses its threshold (weekly 80% and 95%, 5-hour 90%), from `tmp/ops/usage/<account>.json` (see `usage_write.py`, `statusline.py`);
- two hours passed without a wake.

The same script runs the safety net under the check cache (`main_fullcheck.sh`): when `origin/<mainBranch>` moved since the last main run in `tmp/ops/checks.jsonl`, no main run is alive and the check queue is empty, it starts one detached (no wake); a red main run wakes the lead once with `main check red at <sha> (<part> part)`. Switch it off with `"mainCheck": false` in `.claude/foreman.json`.

Its cron expires after 7 days: `claude agents --json --all` shows its id; `{{CLAUDE}} stop <id>`, `{{CLAUDE}} rm <id>`, then start it again. `python3 {{TOOLS}}/lead_status.py` shows whether it is running; the Ops panel's header shows a heart (green busy, blue idle, red off).

If the lead's session name changes, stop the heartbeat and start it again with the new name (and update `lead` in `.claude/foreman.json`, then rerun `/foreman:init` to refresh this file and the CLAUDE.md section).
