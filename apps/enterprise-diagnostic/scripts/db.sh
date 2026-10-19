#!/usr/bin/env bash
#
# R2A B: thin, cwd-independent wrapper around scripts/db-maintenance.mjs.
#
#   scripts/db.sh diagnose [--json] [--state-dir DIR] [--db-file FILE]
#   scripts/db.sh init     [--json] [--state-dir DIR] [--db-file FILE]
#   scripts/db.sh version  [--json]
#
# The application root is resolved from this script's location, so the wrapper
# works from any current working directory. It never creates or edits
# wrangler.toml; missing local configuration is reported by the CLI (exit 3).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf '✘ 找不到 node（需要 Node 22.22.3 或兼容版本）。\n' >&2
  exit 1
fi

exec node "${APP_ROOT}/scripts/db-maintenance.mjs" "$@"
