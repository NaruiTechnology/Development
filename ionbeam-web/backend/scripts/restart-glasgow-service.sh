#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WORKDIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
WORKDIR="${GLASGOW_WORKDIR:-${DEFAULT_WORKDIR}}"
APP="${GLASGOW_APP:-glasgow_service.api:app}"
HOST="${GLASGOW_HOST:-127.0.0.1}"
PORT="${GLASGOW_PORT:-8765}"
LOG_FILE="${GLASGOW_RESTART_LOG:-/tmp/glasgow_service.uvicorn.log}"
DEFAULT_VENV="${VIRTUAL_ENV:-${WORKDIR}/.venv}"
if [[ ! -x "${DEFAULT_VENV}/bin/python" && -x "${WORKDIR}/../.venv/bin/python" ]]; then
  DEFAULT_VENV="$(cd "${WORKDIR}/../.venv" && pwd)"
fi
PYTHON_BIN="${GLASGOW_PYTHON:-${DEFAULT_VENV}/bin/python}"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

export VIRTUAL_ENV="${VIRTUAL_ENV:-${DEFAULT_VENV}}"
export PATH="${VIRTUAL_ENV}/bin:${PATH}"
export PYTHONPATH="${WORKDIR}/glasgow_service:${WORKDIR}${PYTHONPATH:+:${PYTHONPATH}}"

port_pids() {
  ss -ltnp "sport = :${PORT}" 2>/dev/null |
    sed -n 's/.*pid=\([0-9]\+\).*/\1/p' |
    sort -u
}

glasgow_pids() {
  {
    pgrep -f "uvicorn .*${APP}.*--port[ =]${PORT}" || true
    port_pids | while read -r pid; do
      [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
      local cmd
      cmd="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
      [[ "${cmd}" == *"${APP}"* || "${cmd}" == *"glasgow_service"* ]] &&
        printf '%s\n' "${pid}"
    done
  } | sort -u
}

wait_for_exit() {
  local signal="$1"
  local tries="$2"
  shift 2
  local pids=("$@")

  ((${#pids[@]} == 0)) && return 0

  for pid in "${pids[@]}"; do
    [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
    kill "-${signal}" "${pid}" 2>/dev/null || true
  done

  for _ in $(seq 1 "${tries}"); do
    local alive=0
    for pid in "${pids[@]}"; do
      [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
      if kill -0 "${pid}" 2>/dev/null; then
        alive=1
        break
      fi
    done
    ((alive == 0)) && return 0
    sleep 0.5
  done

  return 1
}

wait_for_port_free() {
  for _ in {1..20}; do
    [[ -z "$(port_pids)" ]] && return 0
    sleep 0.25
  done
  return 1
}

wait_for_ready() {
  for _ in {1..40}; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS "http://${HOST}:${PORT}/status" >/dev/null 2>&1 && return 0
    elif [[ -n "$(port_pids)" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

mapfile -t PIDS < <(glasgow_pids)

if (( ${#PIDS[@]} > 0 )); then
  wait_for_exit INT 30 "${PIDS[@]}" ||
    wait_for_exit TERM 20 "${PIDS[@]}" ||
    wait_for_exit KILL 10 "${PIDS[@]}" ||
    true
fi

if ! wait_for_port_free; then
  echo "port ${HOST}:${PORT} is still in use by pid(s): $(port_pids)" >&2
  exit 1
fi

cd "${WORKDIR}"
nohup "${PYTHON_BIN}" -m uvicorn "${APP}" --host "${HOST}" --port "${PORT}" \
  --ws websockets \
  >> "${LOG_FILE}" 2>&1 &
new_pid=$!

if ! wait_for_ready; then
  if ! kill -0 "${new_pid}" 2>/dev/null; then
    echo "failed to start ${APP}; process exited early (log ${LOG_FILE})" >&2
    tail -n 40 "${LOG_FILE}" >&2 || true
  else
    echo "started process ${new_pid}, but ${HOST}:${PORT}/status did not become ready" >&2
  fi
  exit 1
fi

echo "started ${APP} on ${HOST}:${PORT} with ${PYTHON_BIN} (pid ${new_pid}, listener pid(s): $(port_pids), log ${LOG_FILE})"
