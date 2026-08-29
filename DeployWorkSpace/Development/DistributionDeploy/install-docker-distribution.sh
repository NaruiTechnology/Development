#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
      "$(cygpath -w "${SCRIPT_DIR}/install-docker-distribution.ps1")" "$@"
    ;;
  Linux*)
    PYTHON_BIN="${PYTHON_BIN:-python3}"
    command -v "${PYTHON_BIN}" >/dev/null || {
      echo "python3 is required on the Linux build/deploy host" >&2; exit 1;
    }
    cd "${SCRIPT_DIR}"
    "${PYTHON_BIN}" distributionDeployApp-docker.py "$@"
    ;;
  *)
    echo "Unsupported shell OS. Windows requires Git Bash; Linux is native." >&2
    exit 2
    ;;
esac
