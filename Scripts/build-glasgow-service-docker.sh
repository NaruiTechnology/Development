#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OPERATIONS_ROOT="${OPERATIONS_ROOT:-$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)}"
IMAGE="${1:-${GLASGOW_DOCKER_IMAGE:-glasgow-service:local}}"
DOCKERFILE="${OPERATIONS_ROOT}/Development/glasgow_service/deploy/Dockerfile.glasgow-service"

[[ -f "${DOCKERFILE}" ]] || { echo "Dockerfile not found: ${DOCKERFILE}" >&2; exit 1; }
docker build --file "${DOCKERFILE}" --tag "${IMAGE}" "${OPERATIONS_ROOT}"
docker image inspect "${IMAGE}" >/dev/null
echo "Built ${IMAGE} from local Operations sources."
