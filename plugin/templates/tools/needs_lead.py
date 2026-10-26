#!/usr/bin/env python3
"""Tells the heartbeat whether the lead needs waking (heartbeat.md beside this file).

Prints one line: `NOTIFY <why>` when the agents' states, the open PRs or the
backlog changed since the last check-in, or when the lead has not been woken
for NEEDS_LEAD_MAX_QUIET_MIN minutes (default 120: catches a stalled agent,
which changes nothing); otherwise `QUIET`. The heartbeat messages the lead
only on NOTIFY.

Why: a check-in costs the lead one turn at its full context (about 1.40 USD
of list-price usage at 400k tokens), and most check-ins find nothing to do.

With agentsAccount set (.claude/ops-kit.json) agents run on a second account
(claude-agents.sh): each account's background service lists only its own
sessions, so both lists are read.

Stalls: with one report per stop a quiet agent
is normal, so a stuck one is found here, from the session registry
(~/.claude/sessions/<pid>.json: status busy/idle, statusUpdatedAt in ms) and the
agent process's children (`ps`): NOTIFY when a live background agent has been
idle STALL_IDLE_MIN (20) minutes with no command running (a `zsh -c` child is a
command; caffeinate is not), or one command has run STALL_CMD_MIN (150) minutes
(the queue's own limits are 45 and 120). Once per episode: the keys in the state
file's `stalls`. A finished agent is stopped by the lead, so it never trips this.

Ready briefs (a slot must never wait for a brief): lead_status.pipeline_alerts
counts each lane with a minReady (default 2; the lane called flex has none).
Under it, NOTIFY `briefs low: <lane> ...` when the lane first goes low or drops
further (`pipeline` in the state file), and the line rides along on every later
NOTIFY while the lane stays low. `pipeline empty: <lane> ...` means nothing
defined is left to brief: the lead tells the owner. Only a backlog or config
with `lanes` is counted.

Usage thresholds (the lead tells the owner): from
tmp/ops/usage/<account>.json (NEEDS_LEAD_USAGE overrides the folder), NOTIFY
`usage <account> <window> <N>%, resets <when>` when a weekly window crosses 80%
or 95%, or a 5-hour window crosses 90%. Once per crossing per window period
(`usage` in the state file; a resetsAt more than 30 min away from the stored one
is a new period and re-arms it). Readings over 2 h old are ignored.

State lives in tmp/ops/heartbeat_state.json. Inputs can be replaced for
tests: NEEDS_LEAD_AGENTS, NEEDS_LEAD_AGENTS2 and NEEDS_LEAD_PRS (JSON files
instead of `claude agents --json --all` on the main and the agents' account
and `gh pr list`), NEEDS_LEAD_BACKLOG, NEEDS_LEAD_STATE, NEEDS_LEAD_NOW
(epoch seconds), NEEDS_LEAD_CONFIG (a config JSON file instead of
.claude/ops-kit.json), NEEDS_LEAD_SESSIONS (a registry folder), NEEDS_LEAD_PS (a file
with `ps -A -o pid=,ppid=,etime=,command=` output; setting either skips the
pid-alive check).
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # a __pycache__ here would dirty the checkout and turn the suite cache off
sys.path.insert(0, HERE)
from lead_status import pipeline, pipeline_alerts  # noqa: E402  (one rule for both tools)
import ops_config  # noqa: E402

ROOT = ops_config.main_checkout()
OPS = os.path.join(ROOT, 'tmp', 'ops')
AGENTS_CLAUDE = os.path.join(HERE, 'claude-agents.sh')


def load_config():
    path = os.environ.get('NEEDS_LEAD_CONFIG')
    if path:
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}
    return ops_config.load(ROOT)


CONFIG = load_config()
# Sessions that never need the lead: the heartbeat itself and its probes.
IGNORED = (CONFIG.get('heartbeatName') or 'ops-heartbeat', 'ops-probe')
STALL_IDLE_MIN = 20
STALL_CMD_MIN = 150


def etime_seconds(text):
    """ps etime ([[dd-]hh:]mm:ss) to seconds."""
    days, _, rest = text.partition('-') if '-' in text else ('0', '', text)
    parts = [int(x) for x in rest.split(':')]
    while len(parts) < 3:
        parts.insert(0, 0)
    return int(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def process_table():
    path = os.environ.get('NEEDS_LEAD_PS')
    try:
        if path:
            text = open(path).read()
        else:
            text = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,etime=,command='],
                                  capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return []
    rows = []
    for ln in text.splitlines():
        f = ln.split(None, 3)
        if len(f) == 4 and f[0].isdigit() and f[1].isdigit():
            try:
                rows.append((int(f[0]), int(f[1]), etime_seconds(f[2]), f[3]))
            except ValueError:
                pass
    return rows


def is_command(cmd):
    """A shell started with -c: a command the agent is running (not caffeinate)."""
    argv = cmd.split()
    return len(argv) >= 2 and os.path.basename(argv[0]) in ('zsh', 'bash', 'sh') and argv[1] == '-c'


USAGE_STALE_S = 2 * 3600
THRESHOLDS = {'five_hour': (90,), 'seven_day': (80, 95)}


def window_kind(w):
    key = f"{w.get('id') or ''} {w.get('label') or ''}".lower()
    if 'five_hour' in key or key.strip().startswith(('5 hour', '5-hour')):
        return 'five_hour'
    if 'seven_day' in key or 'week' in key:
        return 'seven_day'
    return None


def to_s(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v / 1000 if v > 1e11 else v
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def usage_alerts(now, fired):
    """([messages], new fired state). fired: {"account kind": {"resets": s, "level": N}}."""
    folder = os.environ.get('NEEDS_LEAD_USAGE', os.path.join(OPS, 'usage'))
    msgs, state = [], {}
    for account in ('main', 'agents'):
        keep = {k: v for k, v in fired.items() if k.startswith(account + ' ')}
        try:
            with open(os.path.join(folder, f'{account}.json')) as f:
                doc = json.load(f)
        except Exception:
            state.update(keep)
            continue
        read = to_s(doc.get('readAt') or doc.get('updatedAt'))
        if read is None or now - read > USAGE_STALE_S:
            state.update(keep)
            continue
        for w in doc.get('windows') or []:
            kind, pct, resets = window_kind(w), w.get('percentUsed'), to_s(w.get('resetsAt'))
            if kind is None or isinstance(pct, bool) or not isinstance(pct, (int, float)) or resets is None:
                continue
            key = f'{account} {kind}'
            old = fired.get(key)
            level = old['level'] if old and abs(old['resets'] - resets) <= 1800 else 0
            crossed = [t for t in THRESHOLDS[kind] if pct >= t and t > level]
            if crossed:
                level = max(crossed)
                when = datetime.fromtimestamp(resets)
                day = '' if when.date() == datetime.fromtimestamp(now).date() else when.strftime('%a ')
                msgs.append(f"usage {account} {w.get('label') or kind} {pct:.0f}%, resets {day}{when:%H:%M}")
            state[key] = {'resets': resets, 'level': level}
    return msgs, state


def stalls(now):
    """{episode key: message} for live background agents that look stuck."""
    folder = os.environ.get('NEEDS_LEAD_SESSIONS', os.path.expanduser('~/.claude/sessions'))
    faked = bool(os.environ.get('NEEDS_LEAD_SESSIONS') or os.environ.get('NEEDS_LEAD_PS'))
    table = process_table()
    out = {}
    try:
        names = os.listdir(folder)
    except OSError:
        return out
    for fn in names:
        if not fn.endswith('.json'):
            continue
        try:
            with open(os.path.join(folder, fn)) as f:
                s = json.load(f)
            pid, name = int(s['pid']), s['name']
        except Exception:
            continue
        if s.get('kind') not in ('bg', 'background') or name.startswith(IGNORED):
            continue
        if not faked:
            try:
                os.kill(pid, 0)
            except OSError:
                continue
        cmds = [r for r in table if r[1] == pid and is_command(r[3])]
        since = s.get('statusUpdatedAt') or s.get('updatedAt')
        if s.get('status') == 'idle' and since and not cmds:
            idle = (now - since / 1000) / 60
            if idle >= STALL_IDLE_MIN:
                out[f'idle {name} {since}'] = f'{name} idle {int(idle)} min, nothing running'
        for c in cmds:
            if c[2] >= STALL_CMD_MIN * 60:
                out[f'cmd {name} {c[0]}'] = f'{name}: one command running {c[2] // 60} min'
    return out


def load_json(env, command, default):
    path = os.environ.get(env)
    try:
        if path:
            with open(path) as f:
                return json.load(f)
        # The main account's list must not inherit a caller's CLAUDE_CONFIG_DIR.
        env = {k: v for k, v in os.environ.items() if k != 'CLAUDE_CONFIG_DIR'}
        out = subprocess.run(command, capture_output=True, text=True, timeout=60, env=env)
        return json.loads(out.stdout or 'null') or default
    except Exception:
        return default


def load_backlog():
    try:
        with open(os.environ.get('NEEDS_LEAD_BACKLOG', os.path.join(OPS, 'backlog.json'))) as f:
            return json.load(f)
    except Exception:
        return {'items': []}


def pipeline_check(backlog, old):
    """(fresh, standing, state): fresh lines for lanes newly low, lower than at the
    last run or newly empty; standing lines for lanes still low as before; state
    {lane: [ready, empty]} for the low lanes."""
    data = backlog if isinstance(backlog, dict) else {}
    depth, alerts = pipeline(data, CONFIG), pipeline_alerts(data, CONFIG)
    state, fresh, standing = {}, [], []
    for lane, line in sorted(alerts.items()):
        ready, empty = depth[lane][0], depth[lane][1] == 0
        state[lane] = [ready, empty]
        before = old.get(lane)
        worse = not isinstance(before, list) or ready < before[0] or (empty and not before[1])
        (fresh if worse else standing).append(line)
    return fresh, standing, state


def snapshot(backlog):
    agents = load_json('NEEDS_LEAD_AGENTS', ['claude', 'agents', '--json', '--all'], [])
    if CONFIG.get('agentsAccount') or os.environ.get('NEEDS_LEAD_AGENTS2'):
        agents += load_json('NEEDS_LEAD_AGENTS2', [AGENTS_CLAUDE, 'agents', '--json', '--all'], [])
    prs = load_json('NEEDS_LEAD_PRS', ['gh', 'pr', 'list', '--state', 'open', '--json', 'number'], [])
    snap = {}
    for a in agents:
        name = a.get('name') or a.get('id')
        if not name or name.startswith(IGNORED):
            continue
        # Interactive sessions appear in both lists (the shared registry) without
        # a state; a background session appears once, with its state.
        if 'agent ' + name in snap and not a.get('state'):
            continue
        # state (working, done, stopped) and whether a process is alive; the
        # busy/idle status flips all the time and is left out on purpose.
        snap['agent ' + name] = f"{a.get('state')}{'' if a.get('pid') else ' (no process)'}"
    for p in prs:
        snap[f"PR #{p.get('number')}"] = 'open'
    items = backlog.get('items', []) if isinstance(backlog, dict) else backlog
    for i in items:
        if i.get('status') != 'done':
            snap[i.get('id')] = i.get('status')
    return snap


def main_check(old):
    """The safety net under the suite cache (main_fullcheck.sh beside this
    file). Starts it, detached, when origin/<mainBranch> moved since the last
    main run in checks.jsonl, no main run is alive and the check queue is
    empty (no lock holder, no ticket). Off with `mainCheck: false` in the
    config, and only when a check is configured. Returns (alerts, state): one alert per
    red main run, `main check red at <sha> (<part> part)`. Starting a run is
    no alert. Test overrides: NEEDS_LEAD_MAIN_CMD (the command; without it a
    test that replaces NEEDS_LEAD_STATE never starts anything),
    NEEDS_LEAD_CHECKS, NEEDS_LEAD_MAIN_SHA, NEEDS_LEAD_LOCKS, NEEDS_LEAD_MAIN_PID."""
    cmd = os.environ.get('NEEDS_LEAD_MAIN_CMD')
    if cmd is None:
        if os.environ.get('NEEDS_LEAD_STATE') or CONFIG.get('mainCheck') is False or not ops_config.check_steps(CONFIG):
            return [], old
        cmd = os.path.join(HERE, 'main_fullcheck.sh')
    root = ROOT
    branch = CONFIG.get('mainBranch') or 'main'
    state = dict(old)
    runs = []
    try:
        with open(os.environ.get('NEEDS_LEAD_CHECKS', os.path.join(OPS, 'checks.jsonl'))) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get('branch') == branch and r.get('commit'):
                    runs.append(r)
    except OSError:
        pass
    last = runs[-1] if runs else None
    alerts = []
    if last and last.get('result') != 'green' and last['commit'] not in state.get('red', []):
        alerts.append(f"{branch} check red at {last['commit']} ({last.get('part') or last.get('result')} part): "
                      'tmp/logs/main-check.log')
        state['red'] = (state.get('red', []) + [last['commit']])[-10:]
    pid_path = os.environ.get('NEEDS_LEAD_MAIN_PID', os.path.join(OPS, 'main-check.pid'))
    try:
        with open(pid_path) as f:
            os.kill(int(f.read().strip()), 0)
        return alerts, state  # a main run is alive (waiting in the queue or running)
    except (OSError, ValueError):
        pass
    head = os.environ.get('NEEDS_LEAD_MAIN_SHA')
    if head is None:
        try:
            out = subprocess.run(['git', '-C', root, 'ls-remote', 'origin', f'refs/heads/{branch}'],
                                 capture_output=True, text=True, timeout=30).stdout
            head = out.split()[0] if out.strip() else ''
        except Exception:
            head = ''
    if not head or (last and head.startswith(last['commit'])):
        return alerts, state
    locks = os.environ.get('NEEDS_LEAD_LOCKS') or os.path.join(root, CONFIG.get('locksDir') or 'tmp/agent-locks')
    queue = os.path.join(locks, 'locks', 'check.queue')
    if os.path.exists(os.path.join(locks, 'locks', 'check.lock')) or (os.path.isdir(queue) and os.listdir(queue)):
        return alerts, state
    try:
        subprocess.Popen([cmd], cwd=root, start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        state['started'] = head[:12]
    except OSError:
        pass
    return alerts, state


def main():
    state_path = os.environ.get('NEEDS_LEAD_STATE', os.path.join(OPS, 'heartbeat_state.json'))
    now = float(os.environ.get('NEEDS_LEAD_NOW', time.time()))
    max_quiet = float(os.environ.get('NEEDS_LEAD_MAX_QUIET_MIN', 120)) * 60
    try:
        with open(state_path) as f:
            old = json.load(f)
    except Exception:
        old = None
    backlog = load_backlog()
    snap = snapshot(backlog)
    stuck = stalls(now)
    seen = set((old or {}).get('stalls', []))
    fresh = [m for k, m in sorted(stuck.items()) if k not in seen]
    why = None
    if old is None:
        why = 'first check-in'
    else:
        before = old.get('snap', {})
        changes = []
        for k in sorted(set(before) | set(snap)):
            if before.get(k) != snap.get(k):
                changes.append(f"{k}: {before.get(k, 'none')} -> {snap.get(k, 'gone')}")
        if changes:
            why = '; '.join(changes[:8]) + (f' (+{len(changes) - 8} more)' if len(changes) > 8 else '')
        elif now - old.get('notified', 0) >= max_quiet:
            why = f"no change for {int((now - old.get('notified', 0)) // 60)} min: routine check"
    alerts, usage_state = usage_alerts(now, (old or {}).get('usage', {}))
    fresh += alerts
    red, main_state = main_check((old or {}).get('main', {}))
    fresh += red
    if fresh:
        why = '; '.join(fresh + ([why] if why else []))
    # After the other reasons, so a wake's first words stay what changed.
    low_fresh, low_standing, pipeline_state = pipeline_check(backlog, (old or {}).get('pipeline', {}))
    if low_fresh or (why and low_standing):
        why = '; '.join(([why] if why else []) + low_fresh + low_standing)
    notified = now if why else (old or {}).get('notified', now)
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, 'w') as f:
        json.dump({'snap': snap, 'notified': notified, 'stalls': sorted(stuck), 'usage': usage_state,
                   'main': main_state, 'pipeline': pipeline_state}, f, indent=1)
    print(f'NOTIFY {why}' if why else 'QUIET')


if __name__ == '__main__':
    main()
