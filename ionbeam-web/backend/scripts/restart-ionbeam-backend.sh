#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${IONBEAM_BACKEND_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
START_CMD="${IONBEAM_BACKEND_START_CMD:-npm run dev}"
LOG_FILE="${IONBEAM_BACKEND_LOG:-/tmp/ionbeam-backend.log}"
PID_FILE="${IONBEAM_BACKEND_PID:-/tmp/ionbeam-backend.pid}"

mkdir -p "$(dirname "${LOG_FILE}")" "$(dirname "${PID_FILE}")"

stop_existing() {
  [[ -f "${PID_FILE}" ]] || return 0

  local pid
  pid="$(tr -dc '0-9' < "${PID_FILE}" || true)"
  [[ -n "${pid}" ]] || return 0
  [[ "${pid}" == "$$" ]] && return 0

  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "${pid}" 2>/dev/null || return 0
    sleep 0.25
  done

  kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
}

start_backend() {
  local launch
  printf -v launch 'cd %q && exec %s' "${BACKEND_DIR}" "${START_CMD}"

  if command -v setsid >/dev/null 2>&1; then
    nohup setsid bash -lc "${launch}" >> "${LOG_FILE}" 2>&1 &
  else
    nohup bash -lc "${launch}" >> "${LOG_FILE}" 2>&1 &
  fi

  echo "$!" > "${PID_FILE}"
}

stop_existing
start_backend

echo "started ionbeam-web backend (${START_CMD}) in ${BACKEND_DIR}; pid $(cat "${PID_FILE}"), log ${LOG_FILE}"
