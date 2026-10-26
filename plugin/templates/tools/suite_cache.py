#!/usr/bin/env python3
"""The full check's suite cache.

A `fullCheck` step in .claude/ops-kit.json that carries a `cache` object is
skipped by fullcheck.sh when it already passed on exactly the same inputs. A
step without `cache` always runs, and `checkCommand` alone is never cached.
The step's fingerprint is:

  * the step's name and command;
  * the git tree at HEAD minus the step's `cache.exclude` paths, plus the
    `cache.keep` paths inside an excluded folder;
  * the toolchain, whatever the exclusions say: the tools folder, the config
    file, .gitignore and the paths in `checkCache.toolchain`;
  * the machine: uname plus the output of each `checkCache.machine` command
    (compiler or SDK versions, say) and of the step's `cache.fingerprint`
    commands (a local input outside git, such as a Docker image id).

Exclusion lists only: a path nobody listed is an input, so a mistake there
makes a step run more often, never less. A green step is recorded only from a
clean worktree (no tracked change, no untracked file outside .gitignore), so
the tree at HEAD is exactly what the step saw. The cache never turns a red
into a green: a cached step had the same inputs as a run that passed, and a
failed run records nothing.

One file per green fingerprint in SUITE_CACHE_DIR (default
<main checkout>/tmp/ops/suite-cache/, shared by every worktree). FORCE_ALL=1
disables lookups; recording still happens, so a forced run seeds the cache.

  suite_cache.py fingerprint <part>          print the fingerprint (exit 3: the step is not cacheable)
  suite_cache.py hit <fingerprint>           exit 0 if cached
  suite_cache.py record <fingerprint> <part> <secs>
  suite_cache.py usable                      exit 0 if lookups and records are allowed here
  suite_cache.py inputs <part>               list the step's tree paths
  suite_cache.py lint                        every listed path exists at HEAD
"""
import hashlib
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # a __pycache__ here would dirty the checkout and turn the suite cache off
sys.path.insert(0, HERE)
import ops_config  # noqa: E402

NOT_CACHEABLE = 3


def run(*cmd, cwd=None, shell=False):
    """stdout of cmd, or '<missing>' when it cannot run (a different machine
    state, so a different fingerprint; never an error)."""
    try:
        r = subprocess.run(cmd[0] if shell else cmd, cwd=cwd, shell=shell, capture_output=True, text=True, timeout=60)
    except Exception:
        return '<missing>'
    return r.stdout.strip() if r.returncode == 0 else '<missing>'


def root():
    return run('git', 'rev-parse', '--show-toplevel')


def main_dir():
    return ops_config.main_checkout()


def cache_dir():
    return os.environ.get('SUITE_CACHE_DIR') or os.path.join(main_dir(), 'tmp', 'ops', 'suite-cache')


def strings(value):
    return [v.strip('/') for v in value if isinstance(v, str) and v.strip('/')] if isinstance(value, list) else []


def step_of(config, part):
    for step in ops_config.check_steps(config):
        if step['part'] == part:
            return step
    sys.exit(f'suite_cache: no step named {part}')


def tree():
    """[(path, line)] of every blob and link at HEAD."""
    lines = run('git', 'ls-tree', '-r', '--full-tree', 'HEAD', cwd=root()).splitlines()
    return [(ln.split('\t', 1)[1], ln) for ln in lines if '\t' in ln]


def under(path, prefixes):
    return any(path == p or path.startswith(p + '/') for p in prefixes)


def toolchain_paths(config):
    tools = str(config.get('toolsDir') or 'tools/ops-kit').strip('/')
    extra = config.get('checkCache') if isinstance(config.get('checkCache'), dict) else {}
    return [tools, '.claude/ops-kit.json', '.gitignore'] + strings(extra.get('toolchain'))


def inputs(config, step, entries=None):
    """The tree lines that are the step's inputs."""
    cache = step['cache'] or {}
    excludes, keeps = strings(cache.get('exclude')), strings(cache.get('keep'))
    always = toolchain_paths(config)
    return [ln for p, ln in (entries or tree()) if under(p, always) or not under(p, excludes) or under(p, keeps)]


def machine(config, step, top):
    extra = config.get('checkCache') if isinstance(config.get('checkCache'), dict) else {}
    cmds = [c for c in (extra.get('machine') or []) if isinstance(c, str)]
    cmds += [c for c in ((step['cache'] or {}).get('fingerprint') or []) if isinstance(c, str)]
    return '\n'.join(['uname ' + ' '.join(os.uname()[i] for i in (0, 2, 4))] + [f'{c} => ' + run(c, cwd=top, shell=True) for c in cmds])


def fingerprint(config, step):
    top = root()
    entries = tree()
    if not top or not entries:
        # No tree read means no fingerprint: the caller then runs the step.
        sys.exit('suite_cache: cannot read the tree at HEAD')
    h = hashlib.sha256()
    for part in (f"step {step['part']}", 'command ' + step['command'], machine(config, step, top),
                 '\n'.join(inputs(config, step, entries))):
        h.update(part.encode() + b'\n\0')
    return h.hexdigest()[:32]


def usable():
    """Lookups and records only on a clean worktree: then HEAD's tree is
    exactly what the steps see. (FORCE_ALL=1 turns off lookups only, in hit.)"""
    try:
        r = subprocess.run(['git', 'status', '--porcelain'], capture_output=True, text=True, timeout=30)
    except Exception:
        return False
    return r.returncode == 0 and r.stdout.strip() == ''


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    cmd = argv[1]
    config = ops_config.load(main_dir())
    if cmd == 'fingerprint':
        step = step_of(config, argv[2])
        if step['cache'] is None:
            return NOT_CACHEABLE
        print(fingerprint(config, step))
    elif cmd == 'hit':
        if os.environ.get('FORCE_ALL') == '1':
            return 1
        return 0 if os.path.exists(os.path.join(cache_dir(), argv[2])) else 1
    elif cmd == 'record':
        d = cache_dir()
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, f'.{argv[2]}.{os.getpid()}')
        with open(tmp, 'w') as f:
            json.dump({'step': argv[3], 'seconds': int(argv[4]), 'time': int(time.time()),
                       'commit': run('git', 'rev-parse', '--short', 'HEAD'),
                       'branch': run('git', 'rev-parse', '--abbrev-ref', 'HEAD'),
                       'worktree': root()}, f)
        os.replace(tmp, os.path.join(d, argv[2]))
    elif cmd == 'usable':
        return 0 if usable() else 1
    elif cmd == 'inputs':
        print('\n'.join(ln.split('\t', 1)[1] for ln in inputs(config, step_of(config, argv[2]))))
    elif cmd == 'lint':
        paths = {p for p, _ in tree()}
        missing = set()
        for step in ops_config.check_steps(config):
            cache = step['cache'] or {}
            for p in strings(cache.get('exclude')) + strings(cache.get('keep')):
                if not any(q == p or q.startswith(p + '/') for q in paths):
                    missing.add(f"{step['part']}: {p}")
        for m in sorted(missing):
            print(f'suite_cache: no such path at HEAD: {m}')
        return 1 if missing else 0
    else:
        sys.exit(f'suite_cache: unknown command {cmd}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
