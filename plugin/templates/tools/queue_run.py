#!/usr/bin/env python3
"""Runs a command in its own process group with a wall-clock limit.

    queue_run.py <lock name> <limit minutes> <command...>

On expiry (or SIGTERM/SIGINT to this script) the whole group is killed:
SIGTERM, then SIGKILL after 5 s. Exit codes: the command's own; 124 on a
timeout; 143 / 130 when stopped by SIGTERM / SIGINT. Used by queue.sh
(macOS has no `timeout`).
"""
import os
import signal
import subprocess
import sys
import time


def kill_group(pgid):
    for sig, grace in ((signal.SIGTERM, 5.0), (signal.SIGKILL, 0.0)):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):  # gone, or macOS EPERM for a zombie-only group
            return
        end = time.time() + grace
        while time.time() < end:
            try:
                os.killpg(pgid, 0)
            except (ProcessLookupError, PermissionError):  # macOS: EPERM for a zombie-only group
                return
            time.sleep(0.1)


def main():
    name, minutes, cmd = sys.argv[1], float(sys.argv[2]), sys.argv[3:]
    stopped = []

    try:
        proc = subprocess.Popen(cmd, start_new_session=True)
    except OSError as e:
        print(f"queue.sh: cannot run {cmd[0]}: {e}", file=sys.stderr)
        return 127

    def on_signal(signum, _frame):
        stopped.append(signum)
        kill_group(proc.pid)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    deadline = time.time() + minutes * 60
    while proc.poll() is None:
        if time.time() >= deadline:
            shown = f"{minutes:g}"
            print(f"queue.sh: {name} job timed out after {shown} min: {' '.join(cmd)}", file=sys.stderr, flush=True)
            kill_group(proc.pid)
            proc.wait()
            return 124
        time.sleep(0.1)
    if stopped:
        return 128 + stopped[0]
    # Stragglers of a finished job (daemonised children) must not keep the lock's resource busy.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):  # gone, or macOS EPERM for a zombie-only group
        pass
    return proc.returncode if proc.returncode >= 0 else 128 - proc.returncode


if __name__ == "__main__":
    sys.exit(main())
