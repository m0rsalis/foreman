#!/bin/bash
# Shared helpers for the shell tests: scratch repos under one temp folder.
# shellcheck disable=SC2034  # KIT, INIT and fail are used by the scripts that source this file
KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INIT="$KIT/plugin/scripts/ops_init.py"

# A fresh git repo (main branch, one commit, a Makefile with a check target), printed.
make_repo() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/foreman-test.XXXXXX")
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name "Test Person"
  git -C "$dir" config user.email "test@example.invalid"
  git -C "$dir" config commit.gpgsign false
  printf 'check:\n\t@echo checked\n' >"$dir/Makefile"
  git -C "$dir" add Makefile
  git -C "$dir" commit -q -m init
  # macOS reports /var/... as /private/var/...: use the resolved path.
  (cd "$dir" && pwd -P)
}

fail=0
check() { if [ "$2" != "$3" ]; then echo "FAIL: $1 (got '$2', want '$3')"; fail=1; else echo "ok: $1"; fi; }
contains() { case "$2" in *"$3"*) echo "ok: $1" ;; *) echo "FAIL: $1 (no '$3' in: $(printf '%s' "$2" | tail -5))"; fail=1 ;; esac; }
