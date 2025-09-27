#!/usr/bin/env bash
set -euo pipefail

# KumoMTA UI One-Shot Installer (AlmaLinux 9)
# - Installs Node 18, Nginx, jq, rsync, unzip
# - Creates service user `kumoapi` with journal access
# - Deploys backend API to /opt/kumo-ui-api and sets .env
# - Builds frontend (Vite) and deploys to /var/www/kumo-ui
# - Configures Nginx with /ui/ (alias) and /ui/api/ proxy
#
# Usage:
#   sudo bash scripts/install_kumo_ui.sh --domain mail.example.com --api-key "LONG_RANDOM_SECRET"
#
# Notes:
#   - Assumes KumoMTA metrics are on http://127.0.0.1:8000
#   - You can change PORT or paths with env vars before running, e.g.:
#       PORT=5055 UI_ROOT=/srv/kumo-ui API_DIR=/opt/kumo-ui-api bash scripts/install_kumo_ui.sh ...

DOMAIN=""
API_KEY=""
PORT="${PORT:-5055}"
KUMO_HTTP="${KUMO_HTTP:-http://127.0.0.1:8000}"
UI_ROOT="${UI_ROOT:-/var/www/kumo-ui}"
API_DIR="${API_DIR:-/opt/kumo-ui-api}"
SERVICE_NAME="${SERVICE_NAME:-kumo-ui-api}"
STATE_PATH="${STATE_PATH:-${API_DIR}/state.json}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --api-key) API_KEY="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${DOMAIN}" || -z "${API_KEY}" ]]; then
  echo "Usage: $0 --domain <host> --api-key <secret>" >&2
  exit 1
fi

say() { printf "[%s] %s\n" "$(date +%H:%M:%S)" "$*"; }
exists() { command -v "$1" >/dev/null 2>&1; }

REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

say "1/8 Installing dependencies (git, nginx, nodejs 18)"
dnf -y install epel-release >/dev/null 2>&1 || true
dnf -y install jq rsync unzip git >/dev/null
dnf -y install nginx >/dev/null
dnf -y module enable nodejs:18 >/dev/null || true
dnf -y module install nodejs:18/common >/dev/null

say "2/8 Create service user (kumoapi) and journal access"
if ! id -u kumoapi >/dev/null 2>&1; then
  useradd -r -s /sbin/nologin kumoapi
fi
usermod -aG systemd-journal kumoapi || true

say "3/8 Install backend API to ${API_DIR}"
mkdir -p "${API_DIR}"
rsync -a --delete "${REPO_ROOT}/kumo-ui-api/" "${API_DIR}/"
# .env
cat > "${API_DIR}/.env" <<EOF
NODE_ENV=production
PORT=${PORT}
API_KEY=${API_KEY}
KUMO_HTTP=${KUMO_HTTP}
STATE_PATH=${STATE_PATH}
EOF

pushd "${API_DIR}" >/dev/null
npm install --omit=dev >/dev/null
popd >/dev/null

say "4/8 Install systemd unit"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Kumo UI API Proxy
After=network.target

[Service]
User=kumoapi
Group=kumoapi
SupplementaryGroups=systemd-journal
WorkingDirectory=${API_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ${API_DIR}/server.js
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
systemctl status "${SERVICE_NAME}" --no-pager || true

say "5/8 (Optional) Grant ACLs for kumo logs directory if you store file logs there"
if [[ -d /var/log/kumomta ]]; then
  setfacl -Rm u:kumoapi:rx /var/log/kumomta || true
  setfacl -dm u:kumoapi:rx /var/log/kumomta || true
fi

say "6/8 Build frontend UI"
pushd "${REPO_ROOT}/kumo-ui" >/dev/null
echo "VITE_API_BASE=/ui/api" > .env.production
npm install >/dev/null
npm run build >/dev/null
popd >/dev/null

say "7/8 Deploy static files to ${UI_ROOT}"
mkdir -p "${UI_ROOT}"
rsync -a --delete "${REPO_ROOT}/kumo-ui/dist/" "${UI_ROOT}/"

say "8/8 Configure Nginx"
cat > /etc/nginx/conf.d/kumo-ui.conf <<EOF
server {
  listen 80;
  server_name ${DOMAIN};

  # Redirect /ui -> /ui/
  location = /ui { return 301 /ui/; }

  # Serve the SPA under /ui/
  location /ui/ {
    alias ${UI_ROOT}/;
    try_files \$uri \$uri/ /index.html;
  }

  # Serve built assets referenced as /assets/...
  location /assets/ {
    alias ${UI_ROOT}/assets/;
  }

  # API proxy
  location /ui/api/ {
    proxy_pass http://127.0.0.1:${PORT}/;
    proxy_set_header X-API-Key ${API_KEY};
    proxy_http_version 1.1;
  }
}
EOF

nginx -t

# Ensure Nginx is enabled and started (no silencing)
systemctl enable nginx
systemctl start nginx

# If port 80 is busy (e.g., httpd), try to free it and start again
if ! systemctl --quiet is-active nginx; then
  echo "[warn] nginx failed to start; checking port 80 usage..."
  ss -ltnp | grep ':80' || true
  if systemctl --quiet is-active httpd; then
    echo "[info] stopping Apache httpd to free port 80"
    systemctl stop httpd
    systemctl disable httpd
  fi
  systemctl start nginx || true
fi

# Final check
if ! systemctl --quiet is-active nginx; then
  echo "[error] nginx failed to start; see: journalctl -xeu nginx"
  exit 1
fi

# Reload to pick up our site file (safe now that it's active)
systemctl reload nginx

# Open firewall if firewalld is running
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http >/dev/null || true
  firewall-cmd --reload >/dev/null || true
fi

say "Done."
say "Open:   http://${DOMAIN}/ui/"
say "API:    http://${DOMAIN}/ui/api/metrics/summary  (X-API-Key: ${API_KEY})"
