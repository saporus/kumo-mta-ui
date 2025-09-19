#!/usr/bin/env bash
# scripts/install_kumo_ui.sh
# AlmaLinux 9 installer for KumoMTA UI + API proxy
# Usage: sudo bash scripts/install_kumo_ui.sh --domain mail.example.com --api-key "LONG_RANDOM_SECRET"

set -euo pipefail

DOMAIN=""
API_KEY=""
KUMO_HTTP="http://127.0.0.1:8000"
API_DIR="/opt/kumo-ui-api"
UI_SRC_DIR="$(pwd)/kumo-ui"
UI_BUILD_DIR="$UI_SRC_DIR/dist"
UI_WEB_ROOT="/var/www/kumo-ui"
NGINX_CONF="/etc/nginx/conf.d/kumo-ui.conf"
UNIT_FILE="/etc/systemd/system/kumo-ui-api.service"
SERVICE_USER="kumoapi"
SERVICE_GROUP="kumoapi"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --kumo-http) KUMO_HTTP="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$API_KEY" ]]; then
  echo "Usage: $0 --domain mail.example.com --api-key LONG_RANDOM_SECRET [--kumo-http http://127.0.0.1:8000]"
  exit 1
fi

# --- Root check ---
if [[ "$EUID" -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

echo "[1/8] Installing dependencies (git, nginx, nodejs 18)"
dnf -y install epel-release || true
dnf -y install nginx rsync jq unzip
dnf -y module enable nodejs:18
dnf -y module install nodejs:18

echo "[2/8] Create service user ($SERVICE_USER) and journal access"
id "$SERVICE_USER" &>/dev/null || useradd -r -s /sbin/nologin "$SERVICE_USER"
groupadd -f "$SERVICE_GROUP" || true
usermod -aG systemd-journal "$SERVICE_USER"

echo "[3/8] Install backend API to $API_DIR"
mkdir -p "$API_DIR"
rsync -a "$(pwd)/kumo-ui-api/" "$API_DIR/"
cd "$API_DIR"
cp -n .env.example .env
sed -i "s|^API_KEY=.*$|API_KEY=${API_KEY}|" .env
sed -i "s|^KUMO_HTTP=.*$|KUMO_HTTP=${KUMO_HTTP}|" .env
npm install --omit=dev

echo "[4/8] Install systemd unit"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Kumo UI API Proxy
After=network.target

[Service]
Environment=NODE_ENV=production
EnvironmentFile=$API_DIR/.env
ExecStart=/usr/bin/node $API_DIR/server.js
Restart=always
User=$SERVICE_USER
Group=$SERVICE_GROUP
SupplementaryGroups=systemd-journal
WorkingDirectory=$API_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now kumo-ui-api
systemctl status --no-pager kumo-ui-api || true

echo "[5/8] (Optional) Grant ACLs for kumo logs directory if you store file logs there"
if [[ -d /var/log/kumomta ]]; then
  setfacl -Rm u:${SERVICE_USER}:rx /var/log/kumomta || true
  setfacl -dm u:${SERVICE_USER}:rx /var/log/kumomta || true
fi

echo "[6/8] Build frontend UI"
cd "$UI_SRC_DIR"
echo "VITE_API_BASE=/ui/api" > .env.production
npm install
npm run build

echo "[7/8] Deploy static files to $UI_WEB_ROOT"
mkdir -p "$UI_WEB_ROOT"
rsync -a "$UI_BUILD_DIR/" "$UI_WEB_ROOT/"

echo "[8/8] Configure Nginx"
cat > "$NGINX_CONF" <<EOF
server {
  listen 80;
  server_name ${DOMAIN};

  # UI
  location /ui/ {
    root ${UI_WEB_ROOT};
    try_files \$uri /ui/index.html;
  }

  # API proxy
  location /ui/api/ {
    proxy_pass http://127.0.0.1:5055/;
    proxy_set_header X-API-Key ${API_KEY};
    proxy_http_version 1.1;
  }
}
EOF

nginx -t
systemctl reload nginx

echo "Done!
- UI:        http://${DOMAIN}/ui/
- API proxy: http://127.0.0.1:5055  (local only)
Make sure KumoMTA HTTP is on ${KUMO_HTTP} and bound to 127.0.0.1.
"