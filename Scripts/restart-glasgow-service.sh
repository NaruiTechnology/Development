#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility entrypoint retained for ionbeam-web and existing admin tools.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if (($# == 0)); then set -- restart; fi
exec "${SCRIPT_DIR}/manage-local-system.sh" "$@"
