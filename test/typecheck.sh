#!/bin/bash
# Type-checks the hooks module against the API declarations Claude Code
# writes: beside the plugin once a session loaded it from this folder
# (plugin/.claude-plugin/types/), or under the plugin-authoring skill's
# folder in the temp directory. TYPES=<claude-code.d.ts> picks one. Skips
# (exit 0, one line) when none is found or npx is missing.
here=$(cd "$(dirname "$0")" && pwd)
KIT=$(cd "$here/.." && pwd)
types=${TYPES:-}
if [ -z "$types" ] && [ -f "$KIT/plugin/.claude-plugin/types/claude-code/index.d.ts" ]; then
  types="$KIT/plugin/.claude-plugin/types/claude-code/index.d.ts"
fi
if [ -z "$types" ]; then
  types=$(find -H "${TMPDIR:-/tmp}" /tmp -maxdepth 8 -path '*plugin-authoring/types/claude-code.d.ts' 2>/dev/null | sort -V | tail -1)
fi
if [ -z "$types" ] || ! command -v npx >/dev/null; then
  echo "skip: no claude-code.d.ts found (load the plugin-authoring skill once, or set TYPES=)"
  exit 0
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat >"$work/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2022"], "types": [],
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "noUncheckedIndexedAccess": true,
    "paths": { "claude-code": ["$types"] }
  },
  "files": ["$types", "$KIT/plugin/hooks/register.ts", "$KIT/plugin/types/index.d.ts"]
}
EOF
if npx -y -p typescript@5.6.3 tsc -p "$work/tsconfig.json"; then
  echo "ok: typecheck ($types)"
else
  echo "FAIL: typecheck"
  exit 1
fi
