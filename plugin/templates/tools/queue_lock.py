#!/usr/bin/env python3
"""Lock-folder operations for queue.sh, atomic where bash cannot be.

    queue_lock.py acquire <lock> <pid> <limit min> <command...>   exit 0 got it, 1 held
    queue_lock.py release <lock> <pid>                            frees it if <pid> owns it
    queue_lock.py reap    <lock> <limit min>                      clears a stale lock

A lock is a folder holding owner, started and command (the job's limit is the
command file's last line; the layout stays that of older queue.sh copies). acquire builds
the folder under a temporary name and renames it into place, so a half-written
lock is never visible. A lock is stale when it has no owner file (older than
GRACE seconds), its owner pid is dead, or it was started more than its limit
plus MARGIN minutes ago. reap runs under a short reaper lock (<lock>.reap) and
clears by renaming the folder to a unique name first, so files of a lock taken
meanwhile are never deleted.
"""
import os
import shutil
import sys
import tempfile
import time

GRACE = float(os.environ.get("QUEUE_OWNERLESS_GRACE", "2"))  # seconds an owner-less folder may exist
MARGIN = 5.0  # minutes past the job limit before a lock counts as stale
REAP_STALE = 60.0  # seconds before a reaper lock is itself taken as abandoned


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def alive(pid):
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (ValueError, OverflowError):
        return False
    return True


def stale_reason(lock, limit_min):
    """Why the lock folder is stale, or None."""
    try:
        st = os.stat(lock)
    except OSError:
        return None
    owner = read(os.path.join(lock, "owner"))
    if not owner:
        if time.time() - st.st_mtime > GRACE:
            return "no owner file"
        return None
    if not alive(owner):
        return f"owner pid {owner} is dead"
    started = read(os.path.join(lock, "started"))
    # The limit is the last line of the command file: an extra file would stop an old queue.sh's rmdir.
    lines = (read(os.path.join(lock, "command")) or "").splitlines()
    own_limit = lines[-1] if len(lines) > 1 else None
    try:
        lim = float(own_limit) if own_limit else float(limit_min)
        if started and time.time() - int(started) > (lim + MARGIN) * 60:
            return f"held by pid {owner} for over {lim + MARGIN:g} min"
    except ValueError:
        pass
    return None


def acquire(lock, pid, limit, command):
    parent = os.path.dirname(lock)
    os.makedirs(parent, exist_ok=True)
    if os.path.exists(lock):
        return 1
    tmp = tempfile.mkdtemp(prefix=".new-", dir=parent)
    for name, value in (("command", f"{command}\n{limit}"), ("started", str(int(time.time()))), ("owner", pid)):
        with open(os.path.join(tmp, name), "w") as f:
            f.write(value + "\n")
    try:
        os.rename(tmp, lock)  # fails if a non-empty folder is there
    except OSError:
        shutil.rmtree(tmp, ignore_errors=True)
        return 1
    return 0


def remove_aside(lock):
    """Rename the lock folder to a unique name. Returns the new name."""
    gone = f"{lock}.gone-{os.getpid()}-{time.time_ns()}"
    os.rename(lock, gone)
    return gone


def release(lock, pid):
    if read(os.path.join(lock, "owner")) != pid:
        return 0
    try:
        ino = os.stat(lock).st_ino
        gone = remove_aside(lock)
    except OSError:
        return 0
    if os.stat(gone).st_ino == ino and read(os.path.join(gone, "owner")) == pid:
        shutil.rmtree(gone, ignore_errors=True)
    else:  # not ours after all: put it back
        try:
            os.rename(gone, lock)
        except OSError:
            pass
    return 0


def reap(lock, limit):
    reaper = lock + ".reap"
    try:
        os.mkdir(reaper)
    except FileExistsError:
        try:
            if time.time() - os.stat(reaper).st_mtime > REAP_STALE:
                os.rmdir(reaper)  # abandoned reaper
        except OSError:
            pass
        return 1
    except OSError:
        return 1
    try:
        reason = stale_reason(lock, limit)
        if not reason:
            return 0
        who = read(os.path.join(lock, "owner")) or "none"
        cmd = ((read(os.path.join(lock, "command")) or "").splitlines() or [""])[0][:100]
        try:
            ino = os.stat(lock).st_ino
            gone = remove_aside(lock)
        except OSError:
            return 0
        if os.stat(gone).st_ino != ino or stale_reason(gone, limit) is None:
            # a live lock took its place between the check and the rename: restore it
            try:
                os.rename(gone, lock)
            except OSError:
                pass
            return 0
        shutil.rmtree(gone, ignore_errors=True)
        print(
            f"queue.sh: cleared stale lock {os.path.basename(lock)} (owner {who}: {reason}; command: {cmd})",
            file=sys.stderr,
        )
        return 0
    finally:
        try:
            os.rmdir(reaper)
        except OSError:
            pass


def main():
    op, lock = sys.argv[1], sys.argv[2]
    if op == "acquire":
        return acquire(lock, sys.argv[3], sys.argv[4], " ".join(sys.argv[5:]))
    if op == "release":
        return release(lock, sys.argv[3])
    if op == "reap":
        return reap(lock, sys.argv[3])
    return 2


if __name__ == "__main__":
    sys.exit(main())
