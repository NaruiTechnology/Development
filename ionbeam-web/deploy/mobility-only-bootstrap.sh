#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DOMAIN="${DOMAIN:-ionbeamtech.com}"
WWW_DOMAIN="${WWW_DOMAIN:-www.${DOMAIN}}"
APP_USER="${APP_USER:-ionbeam}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
APP_CHECKOUT="${APP_CHECKOUT:-${APP_HOME}/Project/IobeamTech/Development/ionbeam-web}"
GLASGOW_CONFIG_PATH="${GLASGOW_CONFIG_PATH:-${APP_HOME}/Project/IobeamTech/Development/GlasgowDataIO/Json/streamData.json}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
USE_MOCK="${USE_MOCK:-1}"

SERVICE_PATH="/etc/systemd/system/ionbeam-web.service"
NGINX_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}.conf"
NGINX_DEFAULT_ENABLED="/etc/nginx/sites-enabled/default"
DEPLOY_MODE="mock"

if [[ "${USE_MOCK}" != "1" && -f "${GLASGOW_CONFIG_PATH}" ]]; then
  DEPLOY_MODE="hardware"
fi

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    exec sudo -E bash "$0" "$@"
  fi
}

write_backend_env() {
  local env_file="${APP_ROOT}/backend/.env"
  mkdir -p "$(dirname "${env_file}")"

  if [[ "${USE_MOCK}" == "1" || ! -f "${GLASGOW_CONFIG_PATH}" ]]; then
    cat > "${env_file}" <<EOF
PORT=4000
STATIC_DIR=../frontend/dist
PROXY_TARGET_HTTP=http://127.0.0.1:8765
PROXY_TARGET_WS=ws://127.0.0.1:8765
MOCK=1
IONBEAM_MOBILITY_ONLY=1
IONBEAM_BACKEND_RESTART_CMD=sudo systemctl restart ionbeam-web.service
EOF
  else
    cat > "${env_file}" <<EOF
PORT=4000
STATIC_DIR=../frontend/dist
PROXY_TARGET_HTTP=http://127.0.0.1:8765
PROXY_TARGET_WS=ws://127.0.0.1:8765
MOCK=0
IONBEAM_MOBILITY_ONLY=1
GLASGOW_CONFIG=${GLASGOW_CONFIG_PATH}
GLASGOW_RESTART_CMD=sudo systemctl restart glasgow-svc.service
IONBEAM_BACKEND_RESTART_CMD=sudo systemctl restart ionbeam-web.service
EOF
  fi
}

write_service_unit() {
  local unit_tmp
  unit_tmp="$(mktemp)"

  if [[ "${USE_MOCK}" == "1" || ! -f "${GLASGOW_CONFIG_PATH}" ]]; then
    cat > "${unit_tmp}" <<EOF
[Unit]
Description=Ionbeam Web Backend (Mobility Only)
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
Environment=IONBEAM_WEB_ROOT=${APP_CHECKOUT}
EnvironmentFile=${APP_CHECKOUT}/backend/.env
Environment=NODE_ENV=production
WorkingDirectory=${APP_HOME}
ExecStart=/usr/bin/env bash -lc 'export NVM_DIR="$HOME/.nvm"; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi; cd "$IONBEAM_WEB_ROOT/backend" && exec npm start'
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
  else
    cat > "${unit_tmp}" <<EOF
[Unit]
Description=Ionbeam Web Backend
After=network.target glasgow-svc.service
Requires=glasgow-svc.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
Environment=IONBEAM_WEB_ROOT=${APP_CHECKOUT}
EnvironmentFile=${APP_CHECKOUT}/backend/.env
Environment=NODE_ENV=production
WorkingDirectory=${APP_HOME}
ExecStart=/usr/bin/env bash -lc 'export NVM_DIR="$HOME/.nvm"; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi; cd "$IONBEAM_WEB_ROOT/backend" && exec npm start'
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
  fi

  install -m 0644 "${unit_tmp}" "${SERVICE_PATH}"
  rm -f "${unit_tmp}"
}

write_http_only_nginx() {
  cat > "${NGINX_AVAILABLE}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF

  ln -sfn "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
  rm -f "${NGINX_DEFAULT_ENABLED}"
}

write_tls_nginx() {
  cat > "${NGINX_AVAILABLE}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 256m;

    location /ws/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }
}
EOF
}

install_packages() {
  apt-get update
  apt-get install -y nginx certbot python3-certbot-nginx curl git rsync build-essential ca-certificates
}

install_node20() {
  if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
}

ensure_user() {
  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "${APP_USER}"
  fi
  install -d -o "${APP_USER}" -g "${APP_GROUP}" "${APP_HOME}"
}

build_frontend() {
  cd "${APP_ROOT}/frontend"
  npm ci
  # Do not carry Vite's optimized-dependency cache across dependency changes.
  rm -rf -- node_modules/.vite
  npm run sync:allowed-hosts
  npm run build:mobility
}

build_backend() {
  cd "${APP_ROOT}/backend"
  npm ci
  npm run build
}

obtain_certificate() {
  local email_args=()
  if [[ -n "${LETSENCRYPT_EMAIL}" ]]; then
    email_args=(-m "${LETSENCRYPT_EMAIL}")
  else
    email_args=(--register-unsafely-without-email)
  fi

  certbot certonly \
    --webroot \
    -w /var/www/html \
    --non-interactive \
    --agree-tos \
    --keep-until-expiring \
    "${email_args[@]}" \
    -d "${DOMAIN}" \
    -d "${WWW_DOMAIN}"
}

verify_setup() {
  systemctl status ionbeam-web.service --no-pager
  curl -fsSI "https://${DOMAIN}/" >/dev/null
  curl -fsS "https://${DOMAIN}/healthz" >/dev/null
}

require_root "$@"

echo "Setting up mobility-only deployment for ${DOMAIN} on ${APP_CHECKOUT} (${DEPLOY_MODE} mode)"

if [[ ! -d "${APP_ROOT}" ]]; then
  echo "Expected app checkout at ${APP_ROOT}" >&2
  exit 1
fi

ensure_user
install_packages
install_node20

chown -R "${APP_USER}:${APP_GROUP}" "${APP_HOME}/Project" || true

write_backend_env
write_service_unit
write_http_only_nginx

systemctl enable --now nginx
nginx -t
systemctl reload nginx

build_frontend
build_backend

obtain_certificate

write_tls_nginx
nginx -t
systemctl reload nginx

systemctl daemon-reload
systemctl enable --now ionbeam-web.service
systemctl restart ionbeam-web.service

if command -v ufw >/dev/null 2>&1; then
  ufw allow 'Nginx Full' || true
fi

verify_setup

echo "Mobility-only deployment completed for https://${DOMAIN}"
