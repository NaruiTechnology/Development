#!/usr/bin/env bash
set -euo pipefail

WORKDIR="${GLASGOW_WORKDIR:-/home/vboxuser/Project/IobeamTech}"
APP="${GLASGOW_APP:-glasgow_service.api:app}"
HOST="${GLASGOW_HOST:-127.0.0.1}"
PORT="${GLASGOW_PORT:-8765}"
LOG_FILE="${GLASGOW_RESTART_LOG:-/tmp/glasgow_service.uvicorn.log}"
PYTHON_BIN="${GLASGOW_PYTHON:-${WORKDIR}/.venv/bin/python}"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

export VIRTUAL_ENV="${VIRTUAL_ENV:-${WORKDIR}/.venv}"
export PATH="${VIRTUAL_ENV}/bin:${PATH}"

mapfile -t PIDS < <(
  pgrep -f "uvicorn ${APP} .*--port ${PORT}" || true
  pgrep -f "uvicorn ${APP} --host ${HOST} --port ${PORT}" || true
)

if (( ${#PIDS[@]} > 0 )); then
  printf '%s\n' "${PIDS[@]}" | sort -u | while read -r pid; do
    [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
    kill -INT "${pid}" 2>/dev/null || true
  done

  for _ in {1..30}; do
    alive=0
    printf '%s\n' "${PIDS[@]}" | sort -u | while read -r pid; do
      [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
      kill -0 "${pid}" 2>/dev/null && exit 1
    done || alive=1
    (( alive == 0 )) && break
    sleep 0.5
  done

  printf '%s\n' "${PIDS[@]}" | sort -u | while read -r pid; do
    [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
    kill -TERM "${pid}" 2>/dev/null || true
  done
fi

cd "${WORKDIR}"
nohup "${PYTHON_BIN}" -m uvicorn "${APP}" --host "${HOST}" --port "${PORT}" \
  >> "${LOG_FILE}" 2>&1 &

echo "started ${APP} on ${HOST}:${PORT} with ${PYTHON_BIN} (pid $!, log ${LOG_FILE})"
