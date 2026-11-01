#!/usr/bin/env bash
# PreToolUse (Bash): block destructive commands.
# stdin: hook JSON. Reads tool_input.command.
# Exit 0 = allow. Exit 2 = block; stderr is shown to Claude.
#
# Blocks: rm with recursive+force flags, git push --force (any form), DROP DATABASE.
# This is a text match on the command string, so it is a guardrail, not a sandbox.
set -uo pipefail

command=$(jq -r '.tool_input.command // empty')
[ -n "$command" ] || exit 0

block() {
  echo "BLOCKED by .claude/hooks/block-dangerous.sh: $1" >&2
  echo "Command was: $command" >&2
  echo "Ask the user to run it themselves if it is really intended." >&2
  exit 2
}

# DROP DATABASE, any case or spacing.
if printf '%s' "$command" | grep -qiE 'drop[[:space:]]+database'; then
  block "DROP DATABASE"
fi

# Look at each simple command (split on ; & | and newlines).
while IFS= read -r segment; do
  read -ra tokens <<< "$segment"
  count=${#tokens[@]}
  for ((i = 0; i < count; i++)); do
    token="${tokens[i]##*/}" # so /bin/rm and rm both match

    if [ "$token" = "rm" ]; then
      recursive=0
      force=0
      for ((j = i + 1; j < count; j++)); do
        flag="${tokens[j]}"
        case "$flag" in
          --recursive) recursive=1 ;;
          --force) force=1 ;;
          --*) ;;
          -*[rR]*) recursive=1; [[ "$flag" == *f* ]] && force=1 ;;
          -*f*) force=1 ;;
        esac
      done
      if [ "$recursive" = 1 ] && [ "$force" = 1 ]; then
        block "rm with -r and -f"
      fi
    fi

    if [ "$token" = "git" ]; then
      pushing=0
      for ((j = i + 1; j < count; j++)); do
        flag="${tokens[j]}"
        if [ "$flag" = "push" ]; then pushing=1; continue; fi
        [ "$pushing" = 1 ] || continue
        case "$flag" in
          --force | --force-with-lease* | --force-if-includes | +*) block "force push" ;;
          --*) ;; # other long options, e.g. --follow-tags
          -*f*) block "force push" ;; # -f, -uf, ...
        esac
      done
    fi
  done
done < <(printf '%s\n' "$command" | tr ';&|' '\n\n\n') # trailing \n so read sees the last segment

exit 0
