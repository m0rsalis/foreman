#!/usr/bin/env python3
"""Sets a git repository up for the lead-and-agents way of working.

    ops_init.py [--repo PATH] [--owner NAME] [--lead NAME] [--slug SLUG]
                [--project NAME] [--cap N] [--check CMD] [--locks check:120,db:30]
                [--tools-dir DIR] [--force PATH ...] [--dry-run] [--json]

Writes, in the checkout that holds PATH (default: the current directory):
  .claude/ops-kit.json             the settings (created once; flags given update their keys)
  .claude/agents/<slug>-*.md       three agent tiers: engineer (Opus), implementer (Sonnet), checker (Haiku)
  <tools-dir>/...                  queue, full check, action runner, lead status, heartbeat
  CLAUDE.md                        the rules, between ops-kit markers
  .claude/ops-kit-files.json       what the init wrote last (so a rerun knows what you edited)
and in the main checkout (where every worktree's agents meet):
  tmp/ops/                         status.json, backlog.json, lead-notes.md, briefs/, reports/ (only when missing)
  .gitignore                       tmp/ops/ and tmp/agent-locks/, unless already ignored
  .claude/settings.local.json      the permission entries background agents need (added, never removed)

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
TOOLS = ["queue.sh", "queue_lock.py", "queue_run.py", "fullcheck.sh", "run_action.sh", "lead_status.py", "ops_config.py", "README.md", "heartbeat.md"]
TIERS = ["engineer", "implementer", "checker"]
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
LOCK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


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
        f"Bash(python3 {tools}/lead_status.py:*)",
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
        "NOW": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # 2. Files the init owns until someone edits them.
    for tier in TIERS:
        run.managed(f".claude/agents/{config['slug']}-{tier}.md", render(template(f"agents/{tier}.md"), values))
    for name in TOOLS:
        mode = 0o755 if name.endswith((".sh", ".py")) else None
        text = template(f"tools/{name}")
        if name.endswith(".md"):
            text = render(text, values)
        run.managed(f"{tools}/{name}", text, mode)
    run.claude_md(render(template("claude-section.md"), values))

    # 3. The lead's state, in the main checkout: only when missing.
    run.once(main_root, "tmp/ops/status.json", render(template("state/status.json"), values, is_json=True))
    run.once(main_root, "tmp/ops/backlog.json", render(template("state/backlog.json"), values, is_json=True))
    run.once(main_root, "tmp/ops/lead-notes.md", render(template("state/lead-notes.md"), values))
    run.folder(main_root, "tmp/ops/briefs")
    run.folder(main_root, "tmp/ops/reports")

    # 4. .gitignore: the state and the locks stay out of git.
    probes = (("/tmp/ops/", "tmp/ops/status.json"), ("/tmp/agent-locks/", "tmp/agent-locks/x"),
              ("/.claude/settings.local.json", ".claude/settings.local.json"))
    wanted = [line for line, probe in probes
              if subprocess.run(["git", "-C", top, "check-ignore", "-q", "--no-index", probe], check=False).returncode != 0]
    ignore_path = os.path.join(top, ".gitignore")
    if wanted:
        current = read(ignore_path) or ""
        sep = "" if current == "" or current.endswith("\n") else "\n"
        run.write(ignore_path, current + sep + "# ops kit: the lead's state and the queue locks\n" + "\n".join(wanted) + "\n")
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
