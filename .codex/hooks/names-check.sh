#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

status=0
bun scripts/check-names.ts --tool-call || status=$?
case "$status" in
  0) exit 0 ;;
  1) exit 2 ;;
esac
echo "names check: check:names --tool-call exited $status, so the names this tool call creates went unchecked. Fix the cause above, or run bun run check:names <path> yourself." >&2
exit 1
