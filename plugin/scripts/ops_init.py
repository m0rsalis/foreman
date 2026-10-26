#!/usr/bin/env python3
"""Sets a git repository up for the lead-and-agents way of working.

    ops_init.py [--repo PATH] [--owner NAME] [--lead NAME] [--slug SLUG]
                [--project NAME] [--cap N] [--check CMD] [--locks check:120,db:30]
                [--lanes core:1:src/core+docs,ui:2,flex:1] [--agents-account | --no-agents-account]
                [--main-branch NAME] [--no-main-check] [--usage] [--compact-window TOKENS]
                [--tools-dir DIR] [--force PATH ...] [--dry-run] [--json]

Writes, in the checkout that holds PATH (default: the current directory):
  .claude/ops-kit.json             the settings (created once; flags given update their keys)
  .claude/agents/<slug>-*.md       three agent tiers: engineer (Opus), implementer (Sonnet), checker (Haiku)
  <tools-dir>/...                  queue, full check and its cache, main check, action runner, lead status,
                                   heartbeat filter, quiet runner, second-account wrapper, usage tools
  CLAUDE.md                        the rules, between ops-kit markers
  .claude/ops-kit-files.json       what the init wrote last (so a rerun knows what you edited)
and in the main checkout (where every worktree's agents meet):
  tmp/ops/                         status.json, backlog.json, lead-notes.md, briefs/, reports/ (only when missing)
  .gitignore                       tmp/ops/ and tmp/agent-locks/, unless already ignored
  .claude/settings.local.json      the permission entries background agents need (added, never removed)
  .claude/settings.json            autoCompactWindow and, with --usage, the status line (only keys that are missing)

Idempotent: a second run with the same inputs changes nothing. A file the
init wrote and nobody changed is updated when the kit's version of it
changes; a file someone edited is left alone, its new version goes to
tmp/ops/init-pending/<path>, and --force <path> overwrites it.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES = os.path.join(KIT, "templates")
CONFIG = ".claude/ops-kit.json"
MANIFEST = ".claude/ops-kit-files.json"
BEGIN = "<!-- ops-kit:begin (managed by /ops-kit:init; edit freely, a rerun keeps your edits) -->"
END = "<!-- ops-kit:end -->"
BLOCK_KEY = "CLAUDE.md#ops-kit"
TOOLS = [
    "queue.sh", "queue_lock.py", "queue_run.py", "fullcheck.sh", "steps_json.sh", "suite_cache.py", "main_fullcheck.sh",
    "run_action.sh", "lead_status.py", "needs_lead.py", "ops_config.py", "quiet.sh", "claude-agents.sh",
    "statusline.py", "usage_write.py", "usage_show.py", "README.md", "heartbeat.md",
]
TIERS = ["engineer", "implementer", "checker"]
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
LOCK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
COMPACT_WINDOW = 300000


def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, check=False)
    return r.stdout.strip() if r.returncode == 0 else None


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def load_json(path):
    text = read(path)
    if text is None:
        return None
    return json.loads(text)


def dump_json(value):
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def detect_check(root):
    makefile = read(os.path.join(root, "Makefile")) or ""
    if re.search(r"^check\s*:", makefile, re.M):
        return "make check"
    if re.search(r"^test\s*:", makefile, re.M):
        return "make test"
    pkg = load_json(os.path.join(root, "package.json")) if os.path.exists(os.path.join(root, "package.json")) else None
    if isinstance(pkg, dict) and isinstance(pkg.get("scripts"), dict) and "test" in pkg["scripts"]:
        return "npm test"
    for marker, command in (("Cargo.toml", "cargo test"), ("go.mod", "go test ./..."), ("pyproject.toml", "python3 -m pytest")):
        if os.path.exists(os.path.join(root, marker)):
            return command
    return None


def parse_locks(text):
    out = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        name, _, minutes = part.partition(":")
        if not LOCK.match(name):
            raise SystemExit(f"ops_init: bad lock name {name!r}")
        out.append({"name": name, "timeoutMin": float(minutes) if minutes else 60})
    for lock in out:
        if lock["timeoutMin"] == int(lock["timeoutMin"]):
            lock["timeoutMin"] = int(lock["timeoutMin"])
    return out


def parse_lanes(text):
    """core:1:src/core+docs,ui:2,flex -> [{id, label, cap, owns}]; the cap defaults to 1, the paths to none."""
    out = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        name, _, rest = part.partition(":")
        cap, _, owns = rest.partition(":")
        if not LOCK.match(name):
            raise SystemExit(f"ops_init: bad lane id {name!r}")
        if cap and not cap.isdigit():
            raise SystemExit(f"ops_init: lane {name}: the cap must be a whole number, got {cap!r}")
        out.append({"id": name, "label": name[:1].upper() + name[1:], "cap": int(cap) if cap else 1,
                    "owns": [o for o in owns.split("+") if o]})
    if len({lane["id"] for lane in out}) != len(out):
        raise SystemExit("ops_init: a lane id is listed twice")
    return out


def main_branch(top):
    ref = git(top, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    return ref.split("/", 1)[1] if ref and "/" in ref else "main"


class Run:
    def __init__(self, top, main, dry, force):
        self.top = top
        self.main = main
        self.dry = dry
        self.force = {os.path.normpath(p) for p in force}
        self.results = []  # (action, path, note)
        manifest = load_json(os.path.join(top, MANIFEST)) or {}
        self.recorded = dict(manifest.get("files", {}))
        self.new_recorded = {}

    def note(self, action, path, note=""):
        self.results.append((action, path, note))

    def write(self, path, text, mode=None):
        if self.dry:
            return
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        if mode is not None:
            os.chmod(path, mode)

    def ensure_mode(self, path, mode):
        if mode is not None and not self.dry and os.path.exists(path) and (os.stat(path).st_mode & 0o777) != mode:
            os.chmod(path, mode)

    def pending(self, rel, text):
        self.write(os.path.join(self.main, "tmp", "ops", "init-pending", rel), text)

    def managed(self, rel, text, mode=None):
        """A file the init owns until someone edits it."""
        path = os.path.join(self.top, rel)
        current = read(path)
        if current == text:
            self.new_recorded[rel] = sha(text)
            self.ensure_mode(path, mode)
            self.note("unchanged", rel)
        elif current is None:
            self.write(path, text, mode)
            self.new_recorded[rel] = sha(text)
            self.note("created", rel)
        elif self.recorded.get(rel) == sha(current) or os.path.normpath(rel) in self.force:
            self.write(path, text, mode)
            self.new_recorded[rel] = sha(text)
            self.note("updated", rel, "forced" if self.recorded.get(rel) != sha(current) else "")
        else:
            if rel in self.recorded:
                self.new_recorded[rel] = self.recorded[rel]
            self.pending(rel, text)
            self.note("kept", rel, f"edited here; the kit's version is in tmp/ops/init-pending/{rel}")

    def claude_md(self, block):
        rel = "CLAUDE.md"
        path = os.path.join(self.top, rel)
        current = read(path)
        wrapped = f"{BEGIN}\n{block.rstrip()}\n{END}\n"
        if current is None:
            self.write(path, f"# {os.path.basename(self.top)}\n\n{wrapped}")
            self.new_recorded[BLOCK_KEY] = sha(block.rstrip())
            self.note("created", rel)
            return
        start, end = current.find(BEGIN), current.find(END)
        if start < 0 or end < start:
            sep = "" if current.endswith("\n\n") else ("\n" if current.endswith("\n") else "\n\n")
            self.write(path, f"{current}{sep}{wrapped}")
            self.new_recorded[BLOCK_KEY] = sha(block.rstrip())
            self.note("updated", rel, "ops-kit section added")
            return
        inner = current[start + len(BEGIN):end].strip("\n")
        if inner == block.rstrip():
            self.new_recorded[BLOCK_KEY] = sha(inner)
            self.note("unchanged", rel)
        elif self.recorded.get(BLOCK_KEY) == sha(inner) or rel in self.force:
            self.write(path, current[:start] + wrapped.rstrip("\n") + current[end + len(END):])
            self.new_recorded[BLOCK_KEY] = sha(block.rstrip())
            self.note("updated", rel, "ops-kit section")
        else:
            if BLOCK_KEY in self.recorded:
                self.new_recorded[BLOCK_KEY] = self.recorded[BLOCK_KEY]
            self.pending("CLAUDE.md.ops-kit-section.md", block)
            self.note("kept", rel, "ops-kit section edited here; the kit's version is in tmp/ops/init-pending/CLAUDE.md.ops-kit-section.md")

    def once(self, root, rel, text):
        """State that belongs to the lead: written only when missing."""
        path = os.path.join(root, rel)
        if os.path.exists(path):
            self.note("unchanged", rel)
            return
        self.write(path, text)
        self.note("created", rel)

    def folder(self, root, rel):
        path = os.path.join(root, rel)
        if os.path.isdir(path):
            self.note("unchanged", rel + "/")
            return
        if not self.dry:
            os.makedirs(path, exist_ok=True)
        self.note("created", rel + "/")


def render(text, values, is_json=False):
    def sub(m):
        key = m.group(1)
        if key not in values:
            raise SystemExit(f"ops_init: template placeholder {key} has no value")
        value = str(values[key])
        return json.dumps(value)[1:-1] if is_json else value
    return re.sub(r"\{\{([A-Z_]+)\}\}", sub, text)


def rule(name, values):
    return render(template(f"rules/{name}.md"), values).rstrip("\n")


def template(rel):
    with open(os.path.join(TEMPLATES, rel), encoding="utf-8") as f:
        return f.read()


def check_text(config):
    steps = config.get("fullCheck")
    if isinstance(steps, list) and steps:
        return ", then ".join(
            f"`{s.get('command')}`" + (f" under the `{s['lock']}` lock" if s.get("lock") else "") for s in steps if isinstance(s, dict)
        )
    if config.get("checkCommand"):
        return f"`{config['checkCommand']}`"
    return "not configured yet: set `checkCommand` in `.claude/ops-kit.json`"


def lanes_text(config):
    lanes = [lane for lane in config.get("lanes") or [] if isinstance(lane, dict) and lane.get("id")]
    if not lanes:
        return "No lanes are configured: one queue, the agent cap above is the only limit."
    out = []
    for lane in lanes:
        owns = ", ".join(f"`{o}`" for o in lane.get("owns") or [])
        out.append(f"`{lane['id']}` (cap {lane.get('cap', 1)}{'; owns ' + owns if owns else ''})")
    return "Lanes: " + ", ".join(out) + "."


def permissions(tools):
    return [
        "Bash(claude --bg:*)",
        "Bash(claude agents:*)",
        "Bash(claude logs:*)",
        "Bash(claude stop:*)",
        "Bash(claude rm:*)",
        "SendMessage",
        "Bash(git fetch:*)",
        "Bash(git pull:*)",
        "Bash(git push:*)",
        "Bash(git switch:*)",
        "Bash(git checkout:*)",
        "Bash(git branch:*)",
        "Bash(git merge:*)",
        "Bash(git worktree:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
        "Bash(gh pr view:*)",
        "Bash(gh pr list:*)",
        f"Bash({tools}/queue.sh:*)",
        f"Bash({tools}/fullcheck.sh:*)",
        f"Bash({tools}/claude-agents.sh:*)",
        f"Bash({tools}/quiet.sh:*)",
        f"Bash({tools}/main_fullcheck.sh:*)",
        f"Bash(python3 {tools}/lead_status.py:*)",
        f"Bash(python3 {tools}/needs_lead.py:*)",
        f"Bash(python3 {tools}/usage_write.py:*)",
        f"Bash(python3 {tools}/usage_show.py:*)",
    ]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", default=".")
    p.add_argument("--owner")
    p.add_argument("--lead")
    p.add_argument("--slug")
    p.add_argument("--project")
    p.add_argument("--cap", type=int)
    p.add_argument("--check")
    p.add_argument("--locks")
    p.add_argument("--lanes")
    p.add_argument("--agents-account", action=argparse.BooleanOptionalAction)
    p.add_argument("--main-branch")
    p.add_argument("--main-check", action=argparse.BooleanOptionalAction)
    p.add_argument("--usage", action=argparse.BooleanOptionalAction)
    p.add_argument("--compact-window", type=int)
    p.add_argument("--tools-dir")
    p.add_argument("--force", action="append", default=[])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)

    top = git(os.path.abspath(a.repo), "rev-parse", "--show-toplevel")
    if top is None:
        raise SystemExit(f"ops_init: {a.repo} is not inside a git checkout")
    common = git(top, "rev-parse", "--path-format=absolute", "--git-common-dir")
    main_root = os.path.dirname(common) if common and os.path.basename(common) == ".git" else top
    run = Run(top, main_root, a.dry_run, a.force)

    # 1. The settings: created once, then only the keys given as flags change.
    config_path = os.path.join(top, CONFIG)
    try:
        existing = load_json(config_path)
    except ValueError as e:
        raise SystemExit(f"ops_init: {CONFIG} is not valid JSON ({e}); fix it and run again")
    config = dict(existing or {})
    base = re.sub(r"[^a-z0-9-]+", "-", os.path.basename(top).lower()).strip("-") or "project"
    user = (git(top, "config", "user.name") or "").split(" ")[0]
    slug = a.slug or config.get("slug") or base
    defaults = {
        "project": os.path.basename(top),
        "owner": user or "the owner",
        "slug": slug,
        "lead": f"{slug}-lead",
        "agentCap": 4,
        "toolsDir": "tools/ops-kit",
        "locksDir": "tmp/agent-locks",
        "locks": [{"name": "check", "timeoutMin": 120}],
        "checkCommand": detect_check(top),
        "heartbeatName": f"{slug}-heartbeat",
        "agentsAccount": False,
        "claude": "claude",
        "lanes": [],
        "mainBranch": main_branch(top),
        "mainCheck": True,
        "usage": False,
        "autoCompactWindow": COMPACT_WINDOW,
        "previews": ["tmp/previews"],
        "action": None,
        "decisionLog": None,
        "reviewNotesDir": None,
        "autoOpen": True,
    }
    for key, value in defaults.items():
        config.setdefault(key, value)
    flags = {
        "owner": a.owner, "lead": a.lead, "slug": a.slug, "project": a.project, "agentCap": a.cap,
        "checkCommand": a.check, "toolsDir": a.tools_dir.rstrip("/") if a.tools_dir else None,
        "locks": parse_locks(a.locks) if a.locks else None,
        "lanes": parse_lanes(a.lanes) if a.lanes is not None else None,
        "agentsAccount": a.agents_account, "mainBranch": a.main_branch, "mainCheck": a.main_check,
        "usage": a.usage, "autoCompactWindow": a.compact_window,
    }
    for key, value in flags.items():
        if value is not None:
            config[key] = value
    if not SLUG.match(str(config["slug"])):
        raise SystemExit(f"ops_init: slug {config['slug']!r} must be lowercase letters, digits and dashes")
    tools = str(config["toolsDir"]).strip("/")
    if os.path.isabs(tools) or ".." in tools.split("/"):
        raise SystemExit("ops_init: toolsDir must be a path inside the repo")
    config_text = dump_json(config)
    if existing is None:
        run.write(config_path, config_text)
        run.note("created", CONFIG)
    elif config != existing:
        run.write(config_path, config_text)
        run.note("updated", CONFIG, "keys from the flags")
    else:
        run.note("unchanged", CONFIG)

    lock_list = [lk if isinstance(lk, dict) else {"name": lk} for lk in config.get("locks") or []]
    values = {
        "OWNER": config["owner"],
        "LEAD": config["lead"],
        "SLUG": config["slug"],
        "PROJECT": config["project"],
        "TOOLS": tools,
        "HEARTBEAT": config["heartbeatName"],
        "CHECK": check_text(config),
        "LOCKS": ", ".join(f"`{lk.get('name')}`" for lk in lock_list) or "none",
        "CAP": int(config["agentCap"]),
        "CLAUDE": f"{tools}/claude-agents.sh" if config.get("agentsAccount") else str(config.get("claude") or "claude"),
        "HEARTBEAT_ACCOUNT": " on the agents' account, so the main account's usage limit cannot stop the check-ins" if config.get("agentsAccount") else "",
        "LANES": lanes_text(config),
        "NOW": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    window = int(config.get("autoCompactWindow") or 0)
    has_check = bool(config.get("fullCheck") or config.get("checkCommand"))
    values["MAINBRANCH"] = config["mainBranch"]
    values["COMPACT"] = f"{window // 1000}k tokens" if window > 0 else "off in this repo: the default window applies"
    values["ACCOUNTS_RULE"] = rule("accounts", values) if config.get("agentsAccount") else ""
    values["LANES_RULE"] = rule("lanes", values) if lanes_text(config).startswith("Lanes:") else rule("tracks", values)
    values["USAGE_RULE"] = rule("usage", values) if config.get("usage") else ""
    values["MAINCHECK"] = (
        f"`{tools}/main_fullcheck.sh` is the safety net: a forced check of `origin/{config['mainBranch']}` in its own detached worktree "
        "(`.claude/worktrees/main-check`) whose greens seed the cache; the heartbeat starts it when the branch moved and the queue is empty, "
        "and the lead runs it before a release."
        if config.get("mainCheck", True) and has_check else ""
    )

    # 2. Files the init owns until someone edits them.
    for tier in TIERS:
        run.managed(f".claude/agents/{config['slug']}-{tier}.md", render(template(f"agents/{tier}.md"), values))
    for name in TOOLS:
        mode = 0o755 if name.endswith((".sh", ".py")) else None
        text = template(f"tools/{name}")
        if name.endswith(".md"):
            text = render(text, values)
        run.managed(f"{tools}/{name}", text, mode)
    section = template("claude-section.md")
    for key in ("ACCOUNTS_RULE", "USAGE_RULE"):
        if not values[key]:
            section = section.replace("{{%s}}\n" % key, "")
    run.claude_md(re.sub(r"[ \t]+\n", "\n", render(section, values)))

    # 3. The lead's state, in the main checkout: only when missing.
    run.once(main_root, "tmp/ops/status.json", render(template("state/status.json"), values, is_json=True))
    run.once(main_root, "tmp/ops/backlog.json", render(template("state/backlog.json"), values, is_json=True))
    run.once(main_root, "tmp/ops/lead-notes.md", render(template("state/lead-notes.md"), values))
    run.folder(main_root, "tmp/ops/briefs")
    run.folder(main_root, "tmp/ops/reports")

    # 4. .gitignore: the state and the locks stay out of git.
    # tmp/logs holds quiet.sh and main_fullcheck.sh logs; an untracked file there would make the main
    # checkout dirty and turn the suite cache off.
    probes = (("/tmp/ops/", "tmp/ops/status.json"), ("/tmp/agent-locks/", "tmp/agent-locks/x"), ("/tmp/logs/", "tmp/logs/x"),
              ("/.claude/settings.local.json", ".claude/settings.local.json"), ("/.claude/worktrees/", ".claude/worktrees/x/y"))
    wanted = [line for line, probe in probes
              if subprocess.run(["git", "-C", top, "check-ignore", "-q", "--no-index", probe], check=False).returncode != 0]
    ignore_path = os.path.join(top, ".gitignore")
    if wanted:
        current = read(ignore_path) or ""
        sep = "" if current == "" or current.endswith("\n") else "\n"
        run.write(ignore_path, current + sep + "# ops kit: the lead's state, the queue locks and the agents' worktrees\n" + "\n".join(wanted) + "\n")
        run.note("updated" if current else "created", ".gitignore", ", ".join(wanted))
    else:
        run.note("unchanged", ".gitignore")

    # 5. Permissions for background agents and the queue (added, never removed; hooks untouched).
    settings_rel = ".claude/settings.local.json"
    settings_path = os.path.join(main_root, settings_rel)
    try:
        settings = load_json(settings_path)
    except ValueError:
        settings = False
    if settings is False or (settings is not None and not isinstance(settings, dict)):
        run.note("kept", settings_rel, "not valid JSON; add the permission entries by hand (README)")
    else:
        settings = settings or {}
        perms = settings.setdefault("permissions", {})
        allow = perms.setdefault("allow", [])
        missing = [entry for entry in permissions(tools) if entry not in allow]
        if missing:
            existed = os.path.exists(settings_path)
            allow.extend(missing)
            run.write(settings_path, dump_json(settings))
            run.note("updated" if existed else "created", settings_rel, f"{len(missing)} permission entries added")
        else:
            run.note("unchanged", settings_rel)

    # 5b. Project settings every session reads: the compaction window and, with usage on, the status line.
    # Only keys that are missing are added; a value someone set stays.
    project_rel = ".claude/settings.json"
    project_path = os.path.join(top, project_rel)
    try:
        project = load_json(project_path)
    except ValueError:
        project = False
    if project is False or (project is not None and not isinstance(project, dict)):
        run.note("kept", project_rel, "not valid JSON; add autoCompactWindow and statusLine by hand (README)")
    else:
        project = project or {}
        added = []
        window = int(config.get("autoCompactWindow") or 0)
        if window > 0 and "autoCompactWindow" not in project:
            project["autoCompactWindow"] = window
            added.append("autoCompactWindow")
        if window > 0 and not isinstance(project.get("env"), dict):
            project["env"] = {}
        if window > 0 and isinstance(project.get("env"), dict) and "CLAUDE_CODE_AUTO_COMPACT_WINDOW" not in project["env"]:
            project["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(window)
            added.append("env.CLAUDE_CODE_AUTO_COMPACT_WINDOW")
        if config.get("usage") and "statusLine" not in project:
            project["statusLine"] = {"type": "command", "command": f'python3 "$CLAUDE_PROJECT_DIR"/{tools}/statusline.py'}
            added.append("statusLine")
        if added:
            existed = os.path.exists(project_path)
            run.write(project_path, dump_json(project))
            run.note("updated" if existed else "created", project_rel, ", ".join(added))
        else:
            run.note("unchanged", project_rel)

    # 6. The record of what the init wrote, for the next run.
    manifest = {"kit": "ops-kit", "files": dict(sorted(run.new_recorded.items()))}
    manifest_path = os.path.join(top, MANIFEST)
    if load_json(manifest_path) != manifest:
        existed = os.path.exists(manifest_path)
        run.write(manifest_path, dump_json(manifest))
        run.note("updated" if existed else "created", MANIFEST)
    else:
        run.note("unchanged", MANIFEST)

    counts = {}
    for action, _, _ in run.results:
        counts[action] = counts.get(action, 0) + 1
    summary = ", ".join(f"{counts.get(k, 0)} {k}" for k in ("created", "updated", "unchanged", "kept"))
    if a.json:
        print(json.dumps({
            "repo": top, "main": main_root, "dryRun": a.dry_run, "config": config,
            "results": [{"action": x, "path": y, "note": z} for x, y, z in run.results], "summary": summary,
        }, indent=2))
    else:
        for action, path, note in run.results:
            if action != "unchanged":
                print(f"{action:9} {path}{f'  ({note})' if note else ''}")
        if not config.get("checkCommand") and not config.get("fullCheck"):
            print("note      no check command found: set checkCommand (or fullCheck) in .claude/ops-kit.json")
        print(f"INIT{' (dry run)' if a.dry_run else ''}: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
