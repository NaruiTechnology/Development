#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility entrypoint for GLASGOW_RESTART_CMD. All service orchestration
# lives in Operations/Scripts/manage-local-system.sh.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OPERATIONS_ROOT="$(cd -- "${SCRIPT_DIR}/../../../.." && pwd -P)"
if (($# == 0)); then set -- restart; fi
exec "${OPERATIONS_ROOT}/Scripts/manage-local-system.sh" "$@"
