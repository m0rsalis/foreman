#!/bin/bash
# Lint: shellcheck, Python compile, the plugin and marketplace as Claude Code
# reads them, no project-specific words in what ships, no em dashes in prose.
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
cd "$KIT" || exit 1

if command -v shellcheck >/dev/null; then
  out=$(shellcheck -x -P SCRIPTDIR -S warning plugin/templates/tools/*.sh test/*.sh 2>&1)
  check "shellcheck" "$out" ""
else
  echo "skip: shellcheck not installed"
fi

for f in plugin/scripts/*.py plugin/templates/tools/*.py; do
  out=$(python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$f" 2>&1)
  check "python parses: $f" "$out" ""
done

if command -v claude >/dev/null; then
  out=$(claude plugin validate plugin 2>&1)
  contains "claude plugin validate plugin" "$out" "Validation passed"
  out=$(claude plugin validate . 2>&1)
  contains "claude plugin validate (marketplace)" "$out" "Validation passed"
else
  echo "skip: claude not installed"
fi

# The kit must not carry the project it came from. The manifests' author
# line and the kit's own repository name are allowed.
words='orebit|kishati|tenka|konarik|devicectl|serverpod|flutter'
hits=$(grep -rniE "$words" plugin test README.md --exclude=lint.sh | grep -v '"author"' || true)
check "no project-specific words" "$hits" ""

# Writing style: no em dashes or double dashes as punctuation in prose.
hits=$(grep -rn --include='*.md' --include='*.ts' --include='*.py' --include='*.sh' --include='*.mjs' --include='*.json' --exclude=lint.sh -e "$(printf '\342\200\224')" README.md plugin test || true)
check "no em dashes" "$hits" ""
hits=$(grep -rnE --include='*.md' -e '[a-z] -- [a-z]' README.md plugin || true)
check "no double dashes as punctuation" "$hits" ""

exit $fail
