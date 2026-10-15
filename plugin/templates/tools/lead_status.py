#!/usr/bin/env python3
"""One-screen summary for a lead session starting up or restoring after a clear.

Reads tmp/ops/status.json (agents, sign-off) and tmp/ops/backlog.json and
compares them with what is live: background sessions, git worktrees, the
shared queue locks and open PRs. Read-only. Run from anywhere inside the repo:

    python3 <tools>/lead_status.py
"""
import json
import os
import subprocess
import sys

STATUS_ORDER = ("inbox", "defined", "ready", "in_progress", "review", "blocked", "done")


def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, check=False).stdout.strip()
    except OSError:
        return ""


def norm_status(value):
    return str(value or "inbox").strip().lower().replace("-", "_").replace(" ", "_")


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_config(root):
    config = {}
    for rel in (".claude/ops-kit.json", "tmp/ops/config.json"):
        layer = load_json(os.path.join(root, rel), {})
        if isinstance(layer, dict):
            config.update(layer)
    return config


def lock_names(config):
    raw = config.get("locks", [{"name": "check"}])
    if isinstance(raw, dict):
        return list(raw)
    return [x if isinstance(x, str) else x.get("name") for x in raw if isinstance(x, (str, dict))]


def order_backlog(items):
    """Open items in pick order, each with its unmet dependencies and the next marker.

    The owner's priority (1 = next) first, then the lead's rank; a dependency is
    met when its item is done; the next item is the first ready one that waits for nothing.
    """
    done = {i.get("id") for i in items if norm_status(i.get("status")) == "done"}
    open_items = [i for i in items if norm_status(i.get("status")) != "done"]
    open_items.sort(key=lambda i: (i["priority"] if isinstance(i.get("priority"), (int, float)) else float("inf"),
                                   i.get("rank", 1_000_000)))
    rows = []
    next_found = False
    for i in open_items:
        waits = [d for d in i.get("dependsOn") or [] if d not in done]
        is_next = not next_found and norm_status(i.get("status")) == "ready" and not waits
        next_found = next_found or is_next
        rows.append((i, waits, is_next))
    return rows, len(items) - len(open_items)


def print_backlog(root):
    data = load_json(os.path.join(root, "tmp", "ops", "backlog.json"), None)
    if not isinstance(data, dict):
        print("\nBACKLOG: no tmp/ops/backlog.json")
        return
    items = [i for i in data.get("items", []) if isinstance(i, dict)]
    rows, done = order_backlog(items)
    counts = {}
    for i in items:
        s = norm_status(i.get("status"))
        counts[s] = counts.get(s, 0) + 1
    summary = ", ".join(f"{counts[s]} {s}" for s in STATUS_ORDER if counts.get(s) and s != "done") or "empty"
    print(f"\nBACKLOG ({summary})")
    for i, waits, is_next in rows:
        status = norm_status(i.get("status"))
        marks = [status]
        if isinstance(i.get("priority"), (int, float)):
            marks.append(f"P{i['priority']}")
        if is_next:
            marks.append("NEXT")
        if status == "in_progress" and i.get("agent"):
            marks.append(i["agent"])
        tags = " ".join(t for t in (i.get("track"), i.get("size")) if t)
        print(f"  {i.get('id')} [{' '.join(marks)}] {tags}: {str(i.get('title', ''))[:90]}")
        if status == "blocked":
            print(f"      blocked: {i.get('blockedBy') or 'no reason given'}")
        elif waits:
            print(f"      waits {' '.join(waits)}")
        if i.get("brief") and status in ("ready", "defined"):
            print(f"      brief: {i['brief']}")
    if done:
        print(f"  {done} done")


def main():
    common = sh("git", "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        sys.exit("lead_status: not inside the repo")
    root = os.path.dirname(common) if os.path.basename(common) == ".git" else common
    config = load_config(root)
    owner = config.get("owner") or "the owner"
    heartbeat = config.get("heartbeatName") or "ops-heartbeat"
    status = load_json(os.path.join(root, "tmp", "ops", "status.json"), None)
    if not isinstance(status, dict):
        sys.exit(f"lead_status: cannot read {root}/tmp/ops/status.json (run /ops-kit:init)")

    worktrees = {}
    current = None
    for line in sh("git", "-C", root, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            current = line[9:]
            worktrees[current] = {}
        elif line.startswith("branch ") and current:
            worktrees[current]["branch"] = line[7:].replace("refs/heads/", "")

    # Background sessions (`claude --bg`) outlive the lead's clears; in-process
    # sub-agents (the Agent tool) do not.
    sessions = {}
    try:
        for s in json.loads(sh("claude", "agents", "--json", "--all") or "[]"):
            cwd = s.get("cwd") or ""
            here = cwd == root or cwd.startswith(root + os.sep)
            named = s.get("name") in {a.get("sessionName") or a.get("name") for a in status.get("agents", [])}
            if s.get("kind") == "background" and (here or named):
                # An unnamed session has no name (None or empty): key it by id.
                sessions[s.get("name") or s.get("id") or "(unnamed)"] = s
    except ValueError:
        pass

    cap = status.get("agentLimit", config.get("agentCap", 4))
    print(f"status.json updated {status.get('updated', '?')}; agent cap {cap}; owner {owner}")
    if status.get("priority"):
        print(f"priority: {status['priority']}")
    print("lead notes: tmp/ops/lead-notes.md")

    agents = status.get("agents", [])
    print(f"\nAGENTS ({len(agents)} of {cap})")
    for a in agents:
        wt = a.get("worktree")
        wt_abs = os.path.join(root, wt) if wt and not os.path.isabs(wt) else wt
        live = "worktree present" if wt_abs in worktrees else "no worktree found"
        if a.get("kind") == "bg":
            s = sessions.get(a.get("sessionName") or a.get("name"))
            state = f"{s.get('status')}/{s.get('state')}" if s else "not running"
            sid = (s or {}).get("sessionId") or a.get("sessionId")
            if (not s or s.get("state") in ("done", "stopped")) and sid:
                state += f" (revive: claude --bg --resume {sid} \"<message naming its worktree>\")"
            print(f"  {a.get('name')} [{a.get('model', '?')}, bg: {state}] branch={a.get('branch')} step={a.get('step')}")
        else:
            print(f"  {a.get('name')} [{a.get('model', '?')}, in-process, dies with a clear] id={a.get('agentId', '?')} branch={a.get('branch')} step={a.get('step')}")
        print(f"      {live}; next: {a.get('next')}")

    print("\nBACKGROUND SESSIONS of this repo (claude agents --json --all)")
    known = {a.get("sessionName") or a.get("name") for a in agents}
    for name, s in sessions.items():
        note = "" if name in known or name == heartbeat else "  (not in status.json)"
        print(f"  {name} {s.get('id')} {s.get('status')}/{s.get('state')} {os.path.basename(s.get('cwd') or '')}{note}")
    if not sessions:
        print("  none")
    if heartbeat not in sessions:
        print(f"  heartbeat '{heartbeat}' is not running: see {config.get('toolsDir', 'tools/ops-kit')}/heartbeat.md")

    reports = os.path.join(root, "tmp", "ops", "reports")
    names = sorted(os.listdir(reports)) if os.path.isdir(reports) else []
    print("\nREPORTS (tmp/ops/reports)")
    print("\n".join(f"  {n}" for n in names) or "  none")

    print_backlog(root)

    locks = os.path.join(root, os.environ.get("OPS_AGENT_LOCKS") or config.get("locksDir") or "tmp/agent-locks")
    print("\nLOCKS")
    for name in lock_names(config):
        owner_pid = ""
        try:
            with open(os.path.join(locks, "locks", f"{name}.lock", "owner")) as f:
                owner_pid = f.read().strip()
        except OSError:
            pass
        try:
            waiting = len(os.listdir(os.path.join(locks, "locks", f"{name}.queue")))
        except OSError:
            waiting = 0
        print(f"  {name}: {'held by pid ' + owner_pid if owner_pid else 'free'}, {waiting} ticket(s)")

    print("\nWORKTREES")
    others = [(wt, info) for wt, info in worktrees.items() if wt != root]
    for wt, info in others:
        print(f"  {os.path.relpath(wt, root) if wt.startswith(root) else wt}  {info.get('branch', '(detached)')}")
    if not others:
        print("  none besides the main checkout")

    print(f"\nWAITING FOR {owner.upper()}")
    for s in status.get("signoff", []):
        print(f"  [{s.get('kind')}] {str(s.get('item', ''))[:110]}")
    if not status.get("signoff"):
        print("  nothing")

    prs = sh("gh", "pr", "list", "--state", "open", "--json", "number,title,headRefName",
             "--jq", '.[] | "  #\\(.number) \\(.headRefName): \\(.title)"')
    print("\nOPEN PRS")
    print(prs or "  none (or gh is not available)")


if __name__ == "__main__":
    main()
