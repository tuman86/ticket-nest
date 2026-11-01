#!/usr/bin/env bash
# PreToolUse (Edit|Write): refuse changes to env files and the pnpm lockfile.
# stdin: hook JSON. Reads tool_input.file_path.
# Exit 0 = allow. Exit 2 = block; stderr is shown to Claude.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0

name=$(basename "$file")

case "$name" in
  .env.example) exit 0 ;; # tracked template with names only, no secrets
  .env | .env.*)
    echo "BLOCKED: $file is an env file and may hold secrets. Ask the user to edit it." >&2
    exit 2
    ;;
  pnpm-lock.yaml)
    echo "BLOCKED: pnpm-lock.yaml is generated. Change package.json and run pnpm install instead." >&2
    exit 2
    ;;
esac
exit 0
