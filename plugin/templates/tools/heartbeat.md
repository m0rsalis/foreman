# {{HEARTBEAT}}

A Haiku background session that keeps the lead (`{{LEAD}}`) going: it holds the check-in cron, because the lead's own cron jobs die with a clear. Every 30 minutes (at :17 and :47) it messages the lead "check-in (heartbeat)", and the lead runs `/ops-kit:check-in`. It cannot wake a cleared desktop session (no process to receive the message); the next message from {{OWNER}} restores the lead.

Start it from the main checkout:

```bash
claude --bg --agent {{SLUG}}-checker --model haiku --permission-mode auto --name {{HEARTBEAT}} "You are {{HEARTBEAT}}, a tiny background helper for the lead, the Claude session named '{{LEAD}}'. Your only jobs: (1) Right now, call CronCreate with cron '17,47 * * * *', recurring true, and this prompt: 'Heartbeat: call SendMessage with to set to {{LEAD}} and message: check-in (heartbeat): run /ops-kit:check-in. Then end your turn.' Then send the lead one SendMessage saying 'heartbeat: check-in cron set (17,47), job <id>' and end your turn. (2) If the lead asks for the list of your jobs, call CronList and reply with it. (3) If an agent sends you a report because the lead was unreachable, keep it and forward it to the lead at the next check-in. Never edit files and run no commands other than date. If SendMessage says the lead is not reachable, do nothing; the next fire tries again."
```

Its cron expires after 7 days: `claude agents --json --all` shows its id; `claude stop <id>`, `claude rm <id>`, then start it again. `python3 {{TOOLS}}/lead_status.py` shows whether it is running; the Ops panel's header shows a heart (green busy, blue idle, red off).

If the lead's session name changes, stop the heartbeat and start it again with the new name (and update `lead` in `.claude/ops-kit.json`, then rerun `/ops-kit:init` to refresh this file and the CLAUDE.md section).
