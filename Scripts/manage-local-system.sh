#!/usr/bin/env bash
set -Eeuo pipefail

# Local Operations stack administrator. The checkout may live anywhere: every
# path is derived from this file unless OPERATIONS_ROOT overrides it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OPERATIONS_ROOT="${OPERATIONS_ROOT:-$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)}"
SERVICE_ROOT="${OPERATIONS_ROOT}/Development/glasgow_service"
DEPLOY_DIR="${SERVICE_ROOT}/deploy"
VENV_DIR="${OPERATIONS_VENV:-${OPERATIONS_ROOT}/.venv}"
PYTHON_BIN="${VENV_DIR}/bin/python"
UVICORN_BIN="${VENV_DIR}/bin/uvicorn"
GLASGOW_UNIT="glasgow-svc.service"
EXECUTOR_UNIT="vacuum-executor.service"
SBC_UNIT="sbc-vacuum.service"
BACKEND_UNIT="ionbeam-web-backend.service"
FRONTEND_UNIT="ionbeam-web-frontend.service"
BACKEND_ROOT="${OPERATIONS_ROOT}/Development/ionbeam-web/backend"
FRONTEND_ROOT="${OPERATIONS_ROOT}/Development/ionbeam-web/frontend"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
NPM_DIR="$(dirname -- "${NPM_BIN:-/usr/bin/npm}")"
ACTION="${1:-restart}"

usage() {
  cat <<'EOF'
Usage: manage-local-system.sh [start|restart|stop|status|logs|install]

  start/restart  Install location-aware units, reload systemd, and start stack
  stop           Stop the complete local stack
  status         Show a non-paged summary of every service
  logs           Follow logs for all five services (Ctrl-C exits)
  install        Install/reload/enable units without restarting running services

Environment overrides: OPERATIONS_ROOT, OPERATIONS_VENV, ADMIN_USER.
EOF
}

case "${ACTION}" in
  start|restart|stop|status|logs|install) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

[[ -d "${SERVICE_ROOT}" ]] || {
  echo "Operations service tree not found: ${SERVICE_ROOT}" >&2
  exit 1
}

ADMIN_USER="${ADMIN_USER:-${SUDO_USER:-${USER}}}"
[[ "${ADMIN_USER}" != "root" ]] || {
  echo "Run from the desktop/service account (sudo is requested only when needed), or set ADMIN_USER." >&2
  exit 1
}
ADMIN_UID="$(id -u "${ADMIN_USER}")"
ADMIN_HOME="$(getent passwd "${ADMIN_USER}" | cut -d: -f6)"
USER_SYSTEMD_DIR="${ADMIN_HOME}/.config/systemd/user"

sudo_cmd() {
  if ((EUID == 0)); then "$@"; else sudo "$@"; fi
}

user_systemctl() {
  if [[ "$(id -un)" == "${ADMIN_USER}" ]]; then
    systemctl --user "$@"
  else
    sudo_cmd -u "${ADMIN_USER}" env \
      XDG_RUNTIME_DIR="/run/user/${ADMIN_UID}" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${ADMIN_UID}/bus" \
      systemctl --user "$@"
  fi
}

render() {
  sed \
    -e "s|@OPERATIONS_ROOT@|${OPERATIONS_ROOT}|g" \
    -e "s|@SERVICE_ROOT@|${SERVICE_ROOT}|g" \
    -e "s|@PYTHON_BIN@|${PYTHON_BIN}|g" \
    -e "s|@UVICORN_BIN@|${UVICORN_BIN}|g" \
    -e "s|@NPM_BIN@|${NPM_BIN}|g" \
    -e "s|@NPM_DIR@|${NPM_DIR}|g" \
    -e "s|@BACKEND_ROOT@|${BACKEND_ROOT}|g" \
    -e "s|@FRONTEND_ROOT@|${FRONTEND_ROOT}|g" \
    -e "s|@ADMIN_USER@|${ADMIN_USER}|g" \
    "$1"
}

install_units() {
  [[ -x "${PYTHON_BIN}" && -x "${UVICORN_BIN}" ]] || {
    echo "Missing virtual environment executables under ${VENV_DIR}" >&2
    exit 1
  }
  [[ -x "${NPM_BIN}" ]] || {
    echo "npm was not found; install Node.js/npm or set NPM_BIN." >&2
    exit 1
  }
  local temp_dir
  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "${temp_dir}"' RETURN

  render "${DEPLOY_DIR}/glasgow-svc.local.service.in" >"${temp_dir}/${GLASGOW_UNIT}"
  render "${DEPLOY_DIR}/vacuum-executor.local.service.in" >"${temp_dir}/${EXECUTOR_UNIT}"
  render "${DEPLOY_DIR}/sbc-vacuum.local.service.in" >"${temp_dir}/${SBC_UNIT}"
  render "${DEPLOY_DIR}/ionbeam-web-backend.local.service.in" >"${temp_dir}/${BACKEND_UNIT}"
  render "${DEPLOY_DIR}/ionbeam-web-frontend.local.service.in" >"${temp_dir}/${FRONTEND_UNIT}"

  if [[ ! -f /etc/vacuum-executor.env ]]; then
    sed "s|@SBC_URL@|http://127.0.0.1:8766|g" \
      "${SERVICE_ROOT}/examples/vacuum-executor.local.env.in" \
      >"${temp_dir}/vacuum-executor.env"
    sudo_cmd install -m 0640 "${temp_dir}/vacuum-executor.env" /etc/vacuum-executor.env
    echo "Installed local executor defaults at /etc/vacuum-executor.env."
  fi

  sudo_cmd install -m 0644 "${temp_dir}/${GLASGOW_UNIT}" "/etc/systemd/system/${GLASGOW_UNIT}"
  sudo_cmd install -m 0644 "${temp_dir}/${EXECUTOR_UNIT}" "/etc/systemd/system/${EXECUTOR_UNIT}"
  install -d -m 0755 "${USER_SYSTEMD_DIR}"
  install -m 0644 "${temp_dir}/${SBC_UNIT}" "${USER_SYSTEMD_DIR}/${SBC_UNIT}"
  install -m 0644 "${temp_dir}/${BACKEND_UNIT}" "${USER_SYSTEMD_DIR}/${BACKEND_UNIT}"
  install -m 0644 "${temp_dir}/${FRONTEND_UNIT}" "${USER_SYSTEMD_DIR}/${FRONTEND_UNIT}"

  sudo_cmd systemctl daemon-reload
  user_systemctl daemon-reload
  sudo_cmd systemctl enable "${GLASGOW_UNIT}" "${EXECUTOR_UNIT}"
  user_systemctl enable "${SBC_UNIT}" "${BACKEND_UNIT}" "${FRONTEND_UNIT}"
}

show_status() {
  sudo_cmd systemctl status "${GLASGOW_UNIT}" "${EXECUTOR_UNIT}" --no-pager -l || true
  user_systemctl status "${SBC_UNIT}" "${BACKEND_UNIT}" "${FRONTEND_UNIT}" --no-pager -l || true
}

port_pids() {
  local port="$1"
  ss -ltnpH "sport = :${port}" 2>/dev/null |
    sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u
}

stop_stale_glasgow() {
  local pid command
  while read -r pid; do
    [[ -n "${pid}" ]] || continue
    command="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
    if [[ "${command}" == *"glasgow_service.api"* ]]; then
      echo "Stopping stale Glasgow listener PID ${pid} on port 8765"
      kill -TERM "${pid}" 2>/dev/null || sudo_cmd kill -TERM "${pid}" 2>/dev/null || true
    else
      echo "Port 8765 is occupied by an unrelated process: ${command}" >&2
      exit 1
    fi
  done < <(port_pids 8765)
  for _ in {1..20}; do
    [[ -z "$(port_pids 8765)" ]] && return 0
    sleep 0.25
  done
  echo "Port 8765 did not become free" >&2
  exit 1
}

stop_stale_web_processes() {
  local pattern pid
  for pattern in "${BACKEND_ROOT}.*(tsx|src/server)" "${FRONTEND_ROOT}.*(vite|node)"; do
    while read -r pid; do
      [[ -n "${pid}" && "${pid}" != "$$" ]] || continue
      echo "Stopping stale web development process PID ${pid}"
      kill -TERM "${pid}" 2>/dev/null || true
    done < <(pgrep -f "${pattern}" || true)
  done
  for _ in {1..20}; do
    [[ -z "$(port_pids 4000)" && -z "$(port_pids 5173)" ]] && return 0
    sleep 0.25
  done
  echo "Web port still occupied (4000: $(port_pids 4000); 5173: $(port_pids 5173))" >&2
  exit 1
}

wait_http() {
  local name="$1" url="$2"
  for _ in {1..40}; do
    curl -fsS "${url}" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "${name} did not become ready at ${url}" >&2
  return 1
}

case "${ACTION}" in
  install)
    install_units
    echo "Installed location-aware units for ${OPERATIONS_ROOT}."
    ;;
  start|restart)
    install_units
    user_systemctl stop "${BACKEND_UNIT}" "${FRONTEND_UNIT}" || true
    sudo_cmd systemctl stop "${EXECUTOR_UNIT}" "${GLASGOW_UNIT}" || true
    stop_stale_glasgow
    stop_stale_web_processes
    user_systemctl "${ACTION}" "${SBC_UNIT}"
    wait_http "SBC vacuum" "http://127.0.0.1:8766/health/ready"
    sudo_cmd systemctl start "${GLASGOW_UNIT}"
    wait_http "Glasgow" "http://127.0.0.1:8765/status"
    sudo_cmd systemctl start "${EXECUTOR_UNIT}"
    wait_http "vacuum executor" "http://127.0.0.1:8780/health/live"
    user_systemctl start "${BACKEND_UNIT}"
    wait_http "web backend" "http://127.0.0.1:4000/api/status"
    user_systemctl start "${FRONTEND_UNIT}"
    wait_http "web frontend" "http://127.0.0.1:5173/"
    show_status
    ;;
  stop)
    user_systemctl stop "${FRONTEND_UNIT}" "${BACKEND_UNIT}" "${SBC_UNIT}"
    sudo_cmd systemctl stop "${EXECUTOR_UNIT}" "${GLASGOW_UNIT}"
    ;;
  status)
    show_status
    ;;
  logs)
    echo "Showing recent user-service logs, then following system logs. Ctrl-C exits."
    if [[ "$(id -un)" == "${ADMIN_USER}" ]]; then
      journalctl --user -u "${SBC_UNIT}" -u "${BACKEND_UNIT}" -u "${FRONTEND_UNIT}" -n 80 --no-pager || true
    else
      sudo_cmd -u "${ADMIN_USER}" env XDG_RUNTIME_DIR="/run/user/${ADMIN_UID}" \
        journalctl --user -u "${SBC_UNIT}" -u "${BACKEND_UNIT}" -u "${FRONTEND_UNIT}" -n 80 --no-pager || true
    fi
    sudo_cmd journalctl -u "${GLASGOW_UNIT}" -u "${EXECUTOR_UNIT}" -f
    ;;
esac
