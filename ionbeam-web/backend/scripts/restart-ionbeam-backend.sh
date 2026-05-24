#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="${IONBEAM_BACKEND_DIR:-/home/vboxuser/Project/IobeamTech/Development/ionbeam-web/backend}"
START_CMD="${IONBEAM_BACKEND_START_CMD:-npm run dev}"
PORT="${IONBEAM_BACKEND_PORT:-${PORT:-4000}}"
LOG_FILE="${IONBEAM_BACKEND_LOG:-/tmp/ionbeam-backend.log}"
PID_FILE="${IONBEAM_BACKEND_PID:-/tmp/ionbeam-backend.pid}"

mkdir -p "$(dirname "${LOG_FILE}")" "$(dirname "${PID_FILE}")"

port_pids() {
  ss -ltnp "sport = :${PORT}" 2>/dev/null |
    sed -n 's/.*pid=\([0-9]\+\).*/\1/p' |
    sort -u
}

candidate_pids() {
  {
    if [[ -f "${PID_FILE}" ]]; then
      tr -dc '0-9' < "${PID_FILE}" || true
      printf '\n'
    fi
    port_pids
  } | awk 'NF' | sort -u
}

stop_pid() {
  local pid="$1"
  [[ -n "${pid}" && "${pid}" != "$$" ]] || return 0
  kill -0 "${pid}" 2>/dev/null || return 0

  local pgid
  pgid="$(ps -p "${pid}" -o pgid= 2>/dev/null | tr -d ' ' || true)"
  if [[ -n "${pgid}" && "${pgid}" != "$$" ]]; then
    kill -TERM "-${pgid}" 2>/dev/null || true
  fi
  kill -TERM "${pid}" 2>/dev/null || true
}

stop_existing() {
  local pids=()
  mapfile -t pids < <(candidate_pids)
  ((${#pids[@]} == 0)) && return 0

  local pid
  for pid in "${pids[@]}"; do
    stop_pid "${pid}"
  done

  for _ in {1..20}; do
    [[ -z "$(port_pids)" ]] && return 0
    sleep 0.25
  done

  for pid in "${pids[@]}"; do
    [[ -n "${pid}" && "${pid}" != "$$" ]] || continue
    local pgid
    pgid="$(ps -p "${pid}" -o pgid= 2>/dev/null | tr -d ' ' || true)"
    if [[ -n "${pgid}" && "${pgid}" != "$$" ]]; then
      kill -KILL "-${pgid}" 2>/dev/null || true
    fi
    kill -KILL "${pid}" 2>/dev/null || true
  done
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
