#!/usr/bin/env bash
set -euo pipefail

# Resolve symlinks so this script works when `skills/ibid` is symlinked into
# ~/.gemini/config/skills/ibid or ~/.claude/skills/ibid.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ -x "$REPO_ROOT/dist/ibid" ]; then
  IBID_BIN="$REPO_ROOT/dist/ibid"
elif command -v ibid >/dev/null 2>&1; then
  IBID_BIN="$(command -v ibid)"
else
  (cd "$REPO_ROOT" && bun run build >&2)
  IBID_BIN="$REPO_ROOT/dist/ibid"
fi

if [ "$#" -eq 0 ]; then
  printf '%s\n' "$IBID_BIN"
else
  exec "$IBID_BIN" "$@"
fi
