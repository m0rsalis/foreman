#!/usr/bin/env python3
"""Writes one account's plan usage for the ops panel: tmp/ops/usage/<account>.json.

    usage_write.py <main|agents>   reads the desktop app's usage JSON on stdin:
      {"plan": {"plan": "Team", "windows": [{"label": "5 hour", "percentUsed": 41,
                "resetsAt": "2026-10-17T18:00:00Z"}]}}

The lead (desktop app, main account) has no status line, so it runs this at each
check-in with the app's usage tool output. statusline.py (the CLI sessions)
calls write_usage() too, so both write the same file:

    {"schema": 1, "account": "main", "plan": "Team", "readAt": <ms>,
     "windows": [{"id": "five_hour", "label": "5 hours", "percentUsed": 41.0,
                  "resetsAt": <epoch ms or null>}]}

The folder is the main checkout's tmp/ops (OPS_DIR overrides it for tests); a
worktree's copy of this script finds the main checkout through its repository.
Windows with no readable percentage are dropped; the file is replaced
atomically so the panel never reads half of it.
"""
import json
import os
import sys
import tempfile
import time
from datetime import datetime

sys.dont_write_bytecode = True  # a __pycache__ here would dirty the checkout and turn the suite cache off
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ops_config  # noqa: E402

ACCOUNTS = ('main', 'agents')


def ops_dir():
    if os.environ.get('OPS_DIR'):
        return os.environ['OPS_DIR']
    return os.path.join(ops_config.main_checkout(), 'tmp', 'ops')


def to_ms(v):
    """Epoch seconds, epoch ms or an ISO string to epoch ms; None when unreadable."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v * 1000) if v < 1e11 else int(v)
    if isinstance(v, str):
        try:
            return int(datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() * 1000)
        except ValueError:
            return None
    return None


def percent(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(max(0, min(100, v)))


def write_usage(account, plan, windows, now_ms=None):
    """windows: [{"id","label","percentUsed","resetsAt"(any form to_ms reads)}]."""
    out = []
    for w in windows:
        p = percent(w.get('percentUsed'))
        if p is None:
            continue
        out.append({'id': w.get('id') or w.get('label'), 'label': w.get('label') or w.get('id'),
                    'percentUsed': p, 'resetsAt': to_ms(w.get('resetsAt'))})
    if not out:
        return False
    d = os.path.join(ops_dir(), 'usage')
    os.makedirs(d, exist_ok=True)
    doc = {'schema': 1, 'account': account, 'plan': plan,
           'readAt': int(now_ms if now_ms is not None else time.time() * 1000), 'windows': out}
    fd, tmp = tempfile.mkstemp(dir=d, prefix=f'.{account}.')
    with os.fdopen(fd, 'w') as f:
        json.dump(doc, f, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(d, f'{account}.json'))
    return True


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ACCOUNTS:
        sys.exit('usage: usage_write.py main|agents < app-usage.json')
    try:
        plan = json.load(sys.stdin).get('plan') or {}
    except ValueError as e:
        sys.exit(f'usage_write: input is not JSON: {e}')
    ok = write_usage(sys.argv[1], plan.get('plan'), plan.get('windows') or [])
    print('written' if ok else 'nothing to write: no window with a percentUsed')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
