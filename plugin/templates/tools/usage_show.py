#!/usr/bin/env python3
"""Prints both accounts' plan usage as a compact plain-text table (for a phone).

Reads tmp/ops/usage/<account>.json (written by statusline.py and
usage_write.py; the lead writes main's reading from the desktop app first).
One row per account and window: percent used, the reset in local time plus how
long from now, and the reading's age ("stale" from 15 min). Also reads a file
as the lead once wrote it by hand (`updatedAt` instead of `readAt`, ISO
`resetsAt`). USAGE_SHOW_NOW (epoch seconds) fixes the clock for tests.
"""
import json
import os
import sys
import time
from datetime import datetime

sys.dont_write_bytecode = True  # a __pycache__ here would dirty the checkout and turn the suite cache off
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage_write  # noqa: E402

STALE_MIN = 15
DAYS = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')


def span(ms):
    m = max(0, int(ms // 60000))
    if m >= 1440:
        return f'{m // 1440}d {m % 1440 // 60}h'
    return f'{m // 60}h {m % 60:02d}m' if m >= 60 else f'{m}m'


def reset_text(ms, now_ms):
    if ms is None:
        return 'reset unknown'
    d = datetime.fromtimestamp(ms / 1000)
    day = '' if d.date() == datetime.fromtimestamp(now_ms / 1000).date() else DAYS[d.weekday()] + ' '
    return f'{day}{d:%H:%M} (in {span(ms - now_ms)})' if ms > now_ms else f'{day}{d:%H:%M} (due)'


def rows(directory, now_ms):
    out = []
    for account in usage_write.ACCOUNTS:
        try:
            with open(os.path.join(directory, f'{account}.json')) as f:
                doc = json.load(f)
        except (OSError, ValueError):
            out.append((account, '-', 'no reading', '', ''))
            continue
        read = usage_write.to_ms(doc.get('readAt')) or usage_write.to_ms(doc.get('updatedAt'))
        age = 'age unknown (stale)' if read is None else (
            f'{span(now_ms - read)} old (stale)' if now_ms - read >= STALE_MIN * 60000 else f'{span(now_ms - read)} old')
        for w in doc.get('windows') or []:
            p = usage_write.percent(w.get('percentUsed'))
            if p is None:
                continue
            out.append((account, str(w.get('label') or w.get('id') or '?'), f'{p:.0f}%',
                        reset_text(usage_write.to_ms(w.get('resetsAt')), now_ms), age))
    return out


def main():
    now_ms = float(os.environ.get('USAGE_SHOW_NOW', time.time())) * 1000
    table = [('Account', 'Window', 'Used', 'Resets', 'Reading')] + rows(os.path.join(usage_write.ops_dir(), 'usage'), now_ms)
    widths = [max(len(r[i]) for r in table) for i in range(5)]
    for r in table:
        print('  '.join(c.ljust(widths[i]) for i, c in enumerate(r)).rstrip())


if __name__ == '__main__':
    main()
