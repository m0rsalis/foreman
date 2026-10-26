#!/usr/bin/env python3
"""One-screen summary for a lead session starting up or restoring after a clear.

Reads tmp/ops/status.json (agents, sign-off) and tmp/ops/backlog.json and
compares them with what is live: background sessions (on both accounts when
agents run on a second one), git worktrees, the shared queue locks and open
PRs. Read-only. Run from anywhere inside the repo:

    python3 <tools>/lead_status.py

Lanes (optional): `lanes` in backlog.json (else in .claude/foreman.json) is a
list of {id, label, cap, minReady, owns}. A lane owns paths, so two agents in
different lanes rarely touch the same file; `cap` is its agents at once;
`minReady` (default 2, 0 for a lane called flex) is how many ready briefs the
lead keeps in it so a freed slot never waits for one. Without lanes there is
one queue and no lane logic.
"""
import json
import os
import subprocess
import sys

STATUS_ORDER = ("inbox", "defined", "ready", "in_progress", "review", "blocked", "done")
# The lead keeps this many ready briefs in each lane (the lane's `minReady`),
# so a freed slot never waits for a brief.
MIN_READY = 2
# A dependency in one of these states is done or on its way without the owner;
# one still defined, in review or blocked is not.
COMING = ("done", "running", "in_progress", "ready")


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
    for rel in (".claude/foreman.json", "tmp/ops/config.json"):
        layer = load_json(os.path.join(root, rel), {})
        if isinstance(layer, dict):
            config.update(layer)
    return config


def lock_names(config):
    raw = config.get("locks", [{"name": "check"}])
    if isinstance(raw, dict):
        return list(raw)
    return [x if isinstance(x, str) else x.get("name") for x in raw if isinstance(x, (str, dict))]


def lane_defs(data, config=None):
    """The lanes in display order: backlog.json `lanes`, else `lanes` in the
    config, else none."""
    raw = (data or {}).get("lanes") or (config or {}).get("lanes") or []
    lanes = []
    for lane in raw if isinstance(raw, list) else []:
        if isinstance(lane, dict) and lane.get("id"):
            cap = lane.get("cap")
            min_ready = lane.get("minReady")
            lanes.append({
                "id": lane["id"], "label": lane.get("label") or lane["id"],
                "cap": cap if isinstance(cap, int) else 1,
                "owns": lane.get("owns") or [],
                # A lane called flex takes a slot only when another has nothing ready.
                "minReady": min_ready if isinstance(min_ready, int) else (0 if lane["id"] == "flex" else MIN_READY),
            })
    return lanes


def item_lane(item, lane_ids):
    """An item's lane id; one that names no known lane is flex (or the last lane)."""
    if not lane_ids:
        return None
    lane = item.get("lane")
    if lane in lane_ids:
        return lane
    return "flex" if "flex" in lane_ids else lane_ids[-1]


def agent_lane(agent, items, lane_ids):
    """An agent's lane: its own `lane`, else its in-progress item's lane, else flex."""
    if not lane_ids:
        return None
    fallback = "flex" if "flex" in lane_ids else lane_ids[-1]
    if agent.get("lane"):
        return agent["lane"] if agent["lane"] in lane_ids else fallback
    for i in items:
        if norm_status(i.get("status")) == "in_progress" and i.get("agent") == agent.get("name"):
            return item_lane(i, lane_ids)
    return fallback


def pipeline(data, config=None):
    """{lane: (ready, to_brief)} for the lanes with a minReady, {} without lanes.

    ready: status ready, no blockedBy, every dependency in COMING (a slot can
    take it now or after work already queued). to_brief: status defined and no
    blockedBy, what the lead can brief next.
    """
    lanes = lane_defs(data, config)
    if not lanes:
        return {}
    items = [i for i in (data or {}).get("items", []) if isinstance(i, dict)]
    ids = [lane["id"] for lane in lanes]
    status = {i.get("id"): norm_status(i.get("status")) for i in items}
    out = {lane["id"]: [0, 0] for lane in lanes if lane["minReady"] > 0}
    for i in items:
        lane = item_lane(i, ids)
        if lane not in out or i.get("blockedBy"):
            continue
        st = norm_status(i.get("status"))
        if st == "ready" and all(status.get(d, "done") in COMING for d in i.get("dependsOn") or []):
            out[lane][0] += 1
        elif st == "defined":
            out[lane][1] += 1
    return {lane: tuple(v) for lane, v in out.items()}


def pipeline_alerts(data, config=None):
    """{lane: line} for each lane under its minReady ready items."""
    minimum = {lane["id"]: lane["minReady"] for lane in lane_defs(data, config)}
    alerts = {}
    for lane, (ready, to_brief) in pipeline(data, config).items():
        if ready >= minimum[lane]:
            continue
        if to_brief:
            alerts[lane] = f"briefs low: {lane} {ready} ready (min {minimum[lane]}), {to_brief} defined to brief"
        else:
            alerts[lane] = f"pipeline empty: {lane} {ready} ready, nothing defined to brief: tell the owner"
    return alerts


def lane_summary(data, agents, config=None):
    """One line: each lane's agents against its cap, OVER when above it, its next
    item, and its ready count (LOW under its minReady). Empty without lanes."""
    lanes = lane_defs(data, config)
    if not lanes:
        return ""
    items = [i for i in (data or {}).get("items", []) if isinstance(i, dict)]
    ids = [lane["id"] for lane in lanes]
    rows, _ = order_backlog(items, ids)
    depth = pipeline(data, config)
    parts = []
    for lane in lanes:
        n = sum(1 for a in agents if agent_lane(a, items, ids) == lane["id"])
        nxt = next((i.get("id") for i, _, is_next in rows if is_next and item_lane(i, ids) == lane["id"]), None)
        ready = ""
        if lane["id"] in depth:
            r = depth[lane["id"]][0]
            ready = f" {r} ready" + (" LOW" if r < lane["minReady"] else "")
        parts.append(f"{lane['id']} {n}/{lane['cap']}" + (" OVER" if n > lane["cap"] else "")
                     + (f" (next {nxt})" if nxt else "") + ready)
    return "lanes: " + ", ".join(parts)


def order_backlog(items, lane_ids=None):
    """Open items in pick order, each with its unmet dependencies and the next marker.

    The owner's priority (1 = next) first, then the lead's rank; a dependency is
    met when its item is done; a lane's next item is the first ready one of that
    lane that waits for nothing (without lanes: the first ready one overall).
    """
    lane_ids = lane_ids or []
    done = {i.get("id") for i in items if norm_status(i.get("status")) == "done"}
    open_items = [i for i in items if norm_status(i.get("status")) != "done"]
    open_items.sort(key=lambda i: (i["priority"] if isinstance(i.get("priority"), (int, float)) else float("inf"),
                                   i.get("rank", 1_000_000)))
    rows = []
    found = set()
    for i in open_items:
        waits = [d for d in i.get("dependsOn") or [] if d not in done]
        lane = item_lane(i, lane_ids)
        is_next = lane not in found and norm_status(i.get("status")) == "ready" and not waits
        if is_next:
            found.add(lane)
        rows.append((i, waits, is_next))
    return rows, len(items) - len(open_items)


def load_backlog(root):
    """backlog.json as a dict, None when missing or unreadable."""
    data = load_json(os.path.join(root, "tmp", "ops", "backlog.json"), None)
    return data if isinstance(data, dict) else None


def print_backlog(data, config):
    if data is None:
        print("\nBACKLOG: no tmp/ops/backlog.json")
        return
    items = [i for i in data.get("items", []) if isinstance(i, dict)]
    lanes = lane_defs(data, config)
    ids = [lane["id"] for lane in lanes]
    rows, done = order_backlog(items, ids)
    counts = {}
    for i in items:
        s = norm_status(i.get("status"))
        counts[s] = counts.get(s, 0) + 1
    summary = ", ".join(f"{counts[s]} {s}" for s in STATUS_ORDER if counts.get(s) and s != "done") or "empty"
    print(f"\nBACKLOG ({summary})")
    groups = [(lane["label"].upper(), lane["id"]) for lane in lanes] or [(None, None)]
    for label, lane_id in groups:
        mine = [r for r in rows if item_lane(r[0], ids) == lane_id]
        if not mine:
            continue
        pad = "  "
        if label:
            nxt = next((i.get("id") for i, _, is_next in mine if is_next), None)
            print(f"  {label} ({len(mine)} open" + (f", next {nxt}" if nxt else "") + ")")
            pad = "    "
        for i, waits, is_next in mine:
            status = norm_status(i.get("status"))
            marks = [status]
            if isinstance(i.get("priority"), (int, float)):
                marks.append(f"P{i['priority']}")
            if is_next:
                marks.append("NEXT")
            if status == "in_progress" and i.get("agent"):
                marks.append(i["agent"])
            tags = " ".join(t for t in (i.get("track"), i.get("size")) if t)
            print(f"{pad}{i.get('id')} [{' '.join(marks)}] {tags}: {str(i.get('title', ''))[:90]}")
            if lanes and i.get("lane") and i["lane"] not in ids:
                print(f"{pad}    unknown lane {i['lane']!r}, shown under flex")
            if status == "blocked":
                print(f"{pad}    blocked: {i.get('blockedBy') or 'no reason given'}")
            elif waits:
                print(f"{pad}    waits {' '.join(waits)}")
            if i.get("brief") and status in ("ready", "defined"):
                print(f"{pad}    brief: {i['brief']}")
    if done:
        print(f"  {done} done")


def main():
    # OPS_ROOT: a stand-in checkout for the tests.
    root = os.environ.get("OPS_ROOT")
    if not root:
        common = sh("git", "rev-parse", "--path-format=absolute", "--git-common-dir")
        if not common:
            sys.exit("lead_status: not inside the repo")
        root = os.path.dirname(common) if os.path.basename(common) == ".git" else common
    config = load_config(root)
    owner = config.get("owner") or "the owner"
    heartbeat = config.get("heartbeatName") or "ops-heartbeat"
    tools = config.get("toolsDir") or "tools/foreman"
    status = load_json(os.path.join(root, "tmp", "ops", "status.json"), None)
    if not isinstance(status, dict):
        sys.exit(f"lead_status: cannot read {root}/tmp/ops/status.json (run /foreman:init)")

    worktrees = {}
    current = None
    for line in sh("git", "-C", root, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            current = line[9:]
            worktrees[current] = {}
        elif line.startswith("branch ") and current:
            worktrees[current]["branch"] = line[7:].replace("refs/heads/", "")

    # Background sessions (`claude --bg`) outlive the lead's clears; in-process
    # sub-agents (the Agent tool) do not. With agentsAccount set, agents run on
    # a second account whose background service lists only its own sessions, so
    # both lists are read; each session is tagged with the command that controls it.
    sessions = {}
    accounts = [("main", ["env", "-u", "CLAUDE_CONFIG_DIR", "claude"], "claude")]
    if config.get("agentsAccount"):
        wrapper = os.path.join(root, tools, "claude-agents.sh")
        accounts.append(("agents", [wrapper], f"{tools}/claude-agents.sh"))
    for account, cmd, cli in accounts:
        try:
            for s in json.loads(sh(*cmd, "agents", "--json", "--all") or "[]"):
                cwd = s.get("cwd") or ""
                here = cwd == root or cwd.startswith(root + os.sep)
                named = s.get("name") in {a.get("sessionName") or a.get("name") for a in status.get("agents", [])}
                if s.get("kind") == "background" and (here or named):
                    s["account"], s["cli"] = account, cli
                    # An unnamed session has no name (None or empty): key it by id.
                    sessions[s.get("name") or s.get("id") or "(unnamed)"] = s
        except ValueError:
            pass

    cap = status.get("agentLimit", config.get("agentCap", 4))
    print(f"status.json updated {status.get('updated', '?')}; agent cap {cap}; owner {owner}")
    if status.get("priority"):
        print(f"priority: {status['priority']}")
    print("lead notes: tmp/ops/lead-notes.md")

    backlog = load_backlog(root)
    lane_ids = [lane["id"] for lane in lane_defs(backlog, config)]
    backlog_items = [i for i in (backlog or {}).get("items", []) if isinstance(i, dict)]
    agents = status.get("agents", [])
    print(f"\nAGENTS ({len(agents)} of {cap})")
    for a in agents:
        lane = f" lane={agent_lane(a, backlog_items, lane_ids)}" if lane_ids else ""
        wt = a.get("worktree")
        wt_abs = os.path.join(root, wt) if wt and not os.path.isabs(wt) else wt
        live = "worktree present" if wt_abs in worktrees else "no worktree found"
        if a.get("kind") == "bg":
            s = sessions.get(a.get("sessionName") or a.get("name"))
            state = f"{s.get('status')}/{s.get('state')}" if s else "not running"
            sid = (s or {}).get("sessionId") or a.get("sessionId")
            if (not s or s.get("state") in ("done", "stopped")) and sid:
                cli = (s or {}).get("cli") or ("claude" if not config.get("agentsAccount") else f"{tools}/claude-agents.sh")
                state += f" (revive: {cli} --bg --resume {sid} \"<message naming its worktree>\")"
            print(f"  {a.get('name')} [{a.get('model', '?')}, bg: {state}]{lane} branch={a.get('branch')} step={a.get('step')}")
        else:
            print(f"  {a.get('name')} [{a.get('model', '?')}, in-process, dies with a clear] id={a.get('agentId', '?')}{lane} branch={a.get('branch')} step={a.get('step')}")
        print(f"      {live}; next: {a.get('next')}")
    summary = lane_summary(backlog, agents, config)
    if summary:
        print(f"  {summary}")

    print("\nBACKGROUND SESSIONS of this repo (claude agents --json --all)")
    known = {a.get("sessionName") or a.get("name") for a in agents}
    for name, s in sessions.items():
        note = "" if name in known or name == heartbeat else "  (not in status.json)"
        acct = f" {s['account']} account" if config.get("agentsAccount") else ""
        print(f"  {name} {s.get('id')} {s.get('status')}/{s.get('state')}{acct} {os.path.basename(s.get('cwd') or '')}{note}")
    if not sessions:
        print("  none")
    if heartbeat not in sessions:
        print(f"  heartbeat '{heartbeat}' is not running: see {tools}/heartbeat.md")

    reports = os.path.join(root, "tmp", "ops", "reports")
    names = sorted(os.listdir(reports)) if os.path.isdir(reports) else []
    print("\nREPORTS (tmp/ops/reports)")
    print("\n".join(f"  {n}" for n in names) or "  none")

    print_backlog(backlog, config)

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
