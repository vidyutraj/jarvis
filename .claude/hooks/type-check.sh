#!/usr/bin/env bash
# PostToolUse hook: type-check the project after Claude edits a TypeScript file.
# Exit 2 sends the compiler errors back to Claude so it fixes them right away.
set -euo pipefail

# The hook payload is JSON on stdin; read the edited path as data, never execute it.
file_path="$(jq -r '.tool_input.file_path // empty')"

case "$file_path" in
	*.ts | *.mts | *.cts) ;;
	*) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:?}"

if ! output="$(npm run --silent type-check 2>&1)"; then
	printf 'TypeScript type-check failed after editing %s:\n%s\n' "$file_path" "$output" >&2
	exit 2
fi
