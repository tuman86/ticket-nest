#!/usr/bin/env bash
# Stop: run the workspace typecheck when Claude finishes a turn.
# stdin: hook JSON (session_id, transcript_path, stop_hook_active). No tool_input on Stop.
# Exit 0 = let Claude stop. Exit 2 = keep Claude working; stderr goes to Claude.
set -uo pipefail

input=$(cat)
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

output=$(pnpm typecheck 2>&1)
status=$?
[ "$status" -eq 0 ] && exit 0

tail_output=$(printf '%s\n' "$output" | tail -n 60)

# Already continuing because of this hook once: do not loop forever.
# Let Claude stop but warn the user in the UI.
if [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ]; then
  jq -n --arg out "$tail_output" \
    '{systemMessage: ("TYPECHECK STILL FAILING after a fix attempt:\n" + $out)}'
  exit 0
fi

{
  echo "TYPECHECK FAILED (pnpm typecheck exited $status). Fix these errors before finishing:"
  printf '%s\n' "$tail_output"
} >&2
exit 2
