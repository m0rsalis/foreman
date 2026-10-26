#!/usr/bin/env python3
"""Reads Foreman's config for the shell scripts beside it.

    ops_config.py main                 the main checkout (from any worktree)
    ops_config.py locks-dir            the lock folder (OPS_AGENT_LOCKS wins)
    ops_config.py lock-timeout <name>  minutes; exit 2 when the lock is not declared
    ops_config.py lock-names           one declared lock per line
    ops_config.py check-steps          one JSON object per full-check step: part, lock, command, cache
    ops_config.py check-cache          the global suite-cache settings as one JSON object
    ops_config.py get <key>            a top-level value (strings bare, others as JSON)

The config is <main>/.claude/foreman.json (shared) with <main>/tmp/ops/config.json
(this machine) on top. Missing files read as empty.
"""
import json
import os
import subprocess
import sys

DEFAULT_LOCKS = [{"name": "check", "timeoutMin": 120}]


def main_checkout():
    here = os.path.dirname(os.path.abspath(__file__))
    common = subprocess.run(
        ["git", "-C", here, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        capture_output=True, text=True, check=False,
    ).stdout.strip()
    if not common:
        sys.exit("ops_config: not inside a git checkout")
    return os.path.dirname(common) if os.path.basename(common) == ".git" else common


def load(main):
    config = {}
    for rel in (".claude/foreman.json", "tmp/ops/config.json"):
        try:
            with open(os.path.join(main, rel)) as f:
                layer = json.load(f)
        except FileNotFoundError:
            continue
        except ValueError as e:
            sys.exit(f"ops_config: {rel}: {e}")
        if isinstance(layer, dict):
            config.update(layer)
    return config


def locks(config):
    raw = config.get("locks", DEFAULT_LOCKS)
    out = []
    if isinstance(raw, dict):
        raw = [{"name": k, "timeoutMin": v} for k, v in raw.items()]
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            item = {"name": item}
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            minutes = item.get("timeoutMin")
            out.append({"name": item["name"], "timeoutMin": minutes if isinstance(minutes, (int, float)) and minutes > 0 else 60})
    return out


def check_steps(config):
    steps = config.get("fullCheck")
    if isinstance(steps, list) and steps:
        return [
            {"part": s.get("part") or f"step{i + 1}", "lock": s.get("lock"), "command": s["command"],
             "cache": s["cache"] if isinstance(s.get("cache"), dict) else None}
            for i, s in enumerate(steps) if isinstance(s, dict) and isinstance(s.get("command"), str)
        ]
    command = config.get("checkCommand")
    if not isinstance(command, str) or not command.strip():
        return []
    names = [lk["name"] for lk in locks(config)]
    return [{"part": "check", "lock": "check" if "check" in names else None, "command": command, "cache": None}]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    op = sys.argv[1]
    root = main_checkout()
    config = load(root)
    if op == "main":
        print(root)
    elif op == "locks-dir":
        chosen = os.environ.get("OPS_AGENT_LOCKS") or config.get("locksDir") or "tmp/agent-locks"
        print(os.path.normpath(os.path.join(root, chosen)))
    elif op == "lock-timeout":
        found = [lk for lk in locks(config) if lk["name"] == sys.argv[2]]
        if not found:
            names = ", ".join(lk["name"] for lk in locks(config)) or "none"
            print(f"unknown lock {sys.argv[2]} (declared: {names}; add it to locks in .claude/foreman.json)", file=sys.stderr)
            return 2
        print(f"{found[0]['timeoutMin']:g}")
    elif op == "lock-names":
        for lk in locks(config):
            print(lk["name"])
    elif op == "check-steps":
        for step in check_steps(config):
            print(json.dumps(step))
    elif op == "check-cache":
        cache = config.get("checkCache")
        print(json.dumps(cache if isinstance(cache, dict) else {}))
    elif op == "get":
        value = config.get(sys.argv[2])
        if value is None:
            return 1
        print(value if isinstance(value, str) else json.dumps(value))
    else:
        sys.exit(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
