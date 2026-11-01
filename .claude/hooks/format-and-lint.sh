#!/usr/bin/env bash
# PostToolUse (Edit|Write): run prettier, then eslint --fix, on the file Claude just changed.
# stdin: hook JSON. Reads tool_input.file_path.
# Exit 0 = ok. Exit 2 = problems that --fix could not resolve; stderr goes to Claude.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] && [ -f "$file" ] || exit 0

project_root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
problems=""

# Prettier runs from the repo root. It honours .prettierignore, and
# --ignore-unknown skips file types it cannot parse.
output=$(cd "$project_root" && pnpm exec prettier --write --ignore-unknown "$file" 2>&1) \
  || problems+="prettier failed on $file:"$'\n'"$output"$'\n'

# ESLint config lives per workspace and uses process.cwd() as tsconfigRootDir,
# so it must run from the workspace that owns the file.
case "$file" in
  *.ts | *.tsx | *.mts | *.cts | *.js | *.mjs | *.cjs)
    dir=$(dirname "$file")
    workspace=""
    while [ "$dir" != "/" ] && [ "$dir" != "$project_root" ]; do
      if [ -f "$dir/package.json" ] && ls "$dir"/eslint.config.* > /dev/null 2>&1; then
        workspace="$dir"
        break
      fi
      dir=$(dirname "$dir")
    done

    # Type-aware lint only works for files inside the workspace tsconfig ("src").
    case "$file" in
      "$workspace"/src/* | "$workspace"/eslint.config.*) lintable=1 ;;
      *) lintable=0 ;;
    esac

    if [ -n "$workspace" ] && [ "$lintable" = 1 ]; then
      output=$(cd "$workspace" && pnpm exec eslint --fix --no-warn-ignored "$file" 2>&1) \
        || problems+="eslint found issues --fix could not resolve in $file:"$'\n'"$output"$'\n'
    fi
    ;;
esac

if [ -n "$problems" ]; then
  printf '%s' "$problems" >&2
  exit 2
fi
exit 0
