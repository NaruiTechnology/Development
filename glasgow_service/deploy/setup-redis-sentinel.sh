#!/usr/bin/env bash
# Install/configure a local Redis master and Sentinel for executor smoke tests.
# Production deployments must use three Sentinel processes and a replicated
# Redis topology; this helper intentionally configures quorum=1 only.
set -euo pipefail

MASTER_HOST="${REDIS_MASTER_HOST:-127.0.0.1}"
MASTER_PORT="${REDIS_MASTER_PORT:-6379}"
SENTINEL_PORT="${REDIS_SENTINEL_PORT:-26379}"
MASTER_NAME="${VACUUM_REDIS_MASTER:-vacuum-primary}"

sudo apt-get update
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server

tmp_config="$(mktemp)"
trap 'rm -f "$tmp_config"' EXIT
cat >"$tmp_config" <<EOF
port ${SENTINEL_PORT}
bind 127.0.0.1
protected-mode yes
sentinel monitor ${MASTER_NAME} ${MASTER_HOST} ${MASTER_PORT} 1
sentinel down-after-milliseconds ${MASTER_NAME} 5000
sentinel failover-timeout ${MASTER_NAME} 10000
sentinel parallel-syncs ${MASTER_NAME} 1
EOF
sudo install -m 0644 "$tmp_config" /etc/redis/sentinel.conf
sudo systemctl enable --now redis-sentinel

redis-cli -p "$SENTINEL_PORT" ping
redis-cli -p "$SENTINEL_PORT" SENTINEL get-master-addr-by-name "$MASTER_NAME"
echo "Redis Sentinel smoke-test setup complete. Configure VACUUM_REDIS_SENTINELS=${MASTER_HOST}:${SENTINEL_PORT}."
