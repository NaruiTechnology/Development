#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "${PACKAGE_ROOT}/Development/DistributionDeploy/install-docker-distribution.sh" "$@"
