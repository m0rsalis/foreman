#!/bin/bash
# Prints the body of a JSON object ("a":12,"b":3) from a steps file of
# "<part> <seconds>" lines (written by fullcheck.sh); fullcheck.sh wraps
# it into the line it appends to check-steps.jsonl. Cached steps
# ("<part> cached") are left out; with --cached it prints them instead as
# the body of a JSON array ("a","b").
if [ "${1:-}" = --cached ]; then
  awk '$2=="cached" {printf "%s\"%s\"", (n++?",":""), $1}' "$2"
else
  awk '$2!="cached" {printf "%s\"%s\":%d", (n++?",":""), $1, $2}' "$1"
fi
