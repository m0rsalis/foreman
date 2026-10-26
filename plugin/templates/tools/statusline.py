#!/usr/bin/env python3
"""Project status line (.claude/settings.json): writes the session's plan usage
for the ops panel and prints one short line. Claude Code passes the status line
a JSON object on stdin; its `rate_limits` holds the plan windows:

    {"rate_limits": {"five_hour": {"used_percentage": 41, "resets_at": 1792250000},
                     "seven_day": {...}}}

(percent used; resets_at epoch seconds). The account follows from
CLAUDE_CONFIG_DIR: unset or ~/.claude is main, a folder named .claude-agents (what
claude-agents.sh sets up) is the agents' account.
Every failure is swallowed: a status line must never break a session.
The last raw input is kept as tmp/ops/usage/<account>.input.json, so the shape
can be checked after a Claude Code update.
"""
import json
import os
import sys
import time

sys.dont_write_bytecode = True  # a __pycache__ here would dirty the checkout and turn the suite cache off
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage_write  # noqa: E402

LABELS = {'five_hour': '5 hours', 'seven_day': 'Week'}
SHORT = {'five_hour': '5h', 'seven_day': 'wk'}


def account_of(env):
    d = (env.get('CLAUDE_CONFIG_DIR') or '').rstrip('/')
    return 'agents' if d and os.path.basename(d) == '.claude-agents' else 'main'


def windows_of(data):
    rl = data.get('rate_limits') if isinstance(data, dict) else None
    if not isinstance(rl, dict):
        return []
    out = []
    for key, w in rl.items():
        if isinstance(w, dict) and 'used_percentage' in w:
            out.append({'id': key, 'label': LABELS.get(key, key.replace('_', ' ')),
                        'percentUsed': w.get('used_percentage'), 'resetsAt': w.get('resets_at')})
    return out


def line_of(account, windows):
    parts = []
    for w in windows:
        p = usage_write.percent(w['percentUsed'])
        if p is not None:
            parts.append(f"{SHORT.get(w['id'], w['id'])} {p:.0f}%")
    if not parts:
        return f'{account}: no usage yet'
    first = [usage_write.to_ms(w['resetsAt']) for w in windows if w['id'] == 'five_hour']
    reset = ''
    if first and first[0]:
        mins = max(0, int((first[0] - time.time() * 1000) / 60000))
        reset = f' resets {mins // 60}h{mins % 60:02d}'
    return f'{account}: ' + ' '.join(parts) + reset


def main():
    account = account_of(os.environ)
    try:
        raw = sys.stdin.read()
        data = json.loads(raw or '{}')
        windows = windows_of(data)
        d = os.path.join(usage_write.ops_dir(), 'usage')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{account}.input.json'), 'w') as f:
            f.write(raw)
        plan = data.get('plan') if isinstance(data, dict) and isinstance(data.get('plan'), str) else None
        usage_write.write_usage(account, plan, windows)
        print(line_of(account, windows))
    except Exception:
        print(f'{account}: usage unreadable')


if __name__ == '__main__':
    main()
