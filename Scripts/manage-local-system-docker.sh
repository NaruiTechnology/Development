#!/usr/bin/env bash
set -Eeuo pipefail

# Docker counterpart to manage-local-system.sh. The original systemd manager
# remains unchanged; this script owns only the containerized Glasgow service.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OPERATIONS_ROOT="${OPERATIONS_ROOT:-$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)}"
IMAGE="${GLASGOW_DOCKER_IMAGE:-glasgow-service:local}"
CONTAINER="${GLASGOW_DOCKER_CONTAINER:-glasgowService}"
CONFIG="${GLASGOW_CONFIG:-${OPERATIONS_ROOT}/Development/GlasgowDataIO/Json/streamData.json}"
TOKEN="${GLASGOW_TOKEN:-}"
ACTION="${1:-restart}"

docker_cmd() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo docker "$@"; fi
}

start_container() {
  [[ -f "${CONFIG}" ]] || { echo "Glasgow config not found: ${CONFIG}" >&2; exit 1; }
  docker_cmd image inspect "${IMAGE}" >/dev/null || {
    "${SCRIPT_DIR}/build-glasgow-service-docker.sh" "${IMAGE}"
  }
  docker_cmd rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker_cmd run -d \
    --name "${CONTAINER}" \
    --restart unless-stopped \
    -p 8765:8765 \
    --privileged \
    -e "GLASGOW_TOKEN=${TOKEN}" \
    -e GLASGOW_CONFIG=/app/config/streamData.json \
    -v "${CONFIG}:/app/config/streamData.json:ro" \
    "${IMAGE}" >/dev/null
  for _ in {1..60}; do
    curl -fsS http://127.0.0.1:8765/status >/dev/null 2>&1 && {
      echo "${CONTAINER} is ready at http://127.0.0.1:8765"; return 0;
    }
    sleep 1
  done
  docker_cmd logs "${CONTAINER}" >&2 || true
  echo "${CONTAINER} did not become ready" >&2
  return 1
}

case "${ACTION}" in
  start) start_container ;;
  restart) docker_cmd rm -f "${CONTAINER}" >/dev/null 2>&1 || true; start_container ;;
  stop) docker_cmd rm -f "${CONTAINER}" >/dev/null 2>&1 || true ;;
  status) docker_cmd ps -a --filter "name=^/${CONTAINER}$" ;;
  logs) docker_cmd logs -f "${CONTAINER}" ;;
  *) echo "Usage: $0 [start|restart|stop|status|logs]" >&2; exit 2 ;;
esac
