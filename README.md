# KumoMTA UI (MagicSMTP-style)

A modern, MailerQ-style admin UI for **KumoMTA** with:
- React + Tailwind frontend (Vite)
- Secure local **proxy API** (Node/Express) for metrics, policy reload, queue actions, and live logs (SSE)
- Nginx config and systemd unit for production deploy on AlmaLinux 9

> Assumes **KumoMTA is already installed** and its HTTP listener is bound to `127.0.0.1:8000`.

---

## Features

- **Dashboard:** throughput, queue, recent events, quick actions (Reload Policy, Flush Queue)
- **Shaping Rules:** TOML blocks (gmail/yahoo/outlook) with validate/reload buttons
- **Domains, IP Pools, DKIM:** clean tables/cards ready to wire to your backend
- **Logs:** live `journalctl -u kumomta` streaming via Server-Sent Events
- **API:** documented endpoints behind Nginx, protected by an API key header

---

## Repo Layout

```
kumo-mta-ui/
├─ kumo-ui/              # Vite + React + Tailwind (frontend source)
├─ kumo-ui-api/          # Node/Express proxy (server.js, package.json, .env.example)
├─ nginx/
│  └─ kumo-ui.conf       # Nginx site snippet (serves /ui/, proxies /ui/api/)
├─ systemd/
│  └─ kumo-ui-api.service# systemd unit for the proxy
├─ scripts/
│  └─ install_kumo_ui.sh # One-shot installer (AlmaLinux 9)
└─ README.md
```

---

## Quick Start (Dev)

### Prereqs
- Node.js **18+**
- KumoMTA HTTP on `http://127.0.0.1:8000` (local only)

### Frontend (dev)
```bash
cd kumo-ui
npm install
npm run dev
```

### Backend proxy (dev)
```bash
cd kumo-ui-api
cp .env.example .env
# edit .env: set a long random API_KEY
npm install
node server.js
```

The proxy exposes:
- `GET  /metrics` → `http://127.0.0.1:8000/metrics.json`
- `POST /policy/reload` → `systemctl reload kumomta` (default)
- `POST /queue/flush` → (stub; wire to your workflow)
- `GET  /logs/stream` → live `journalctl -u kumomta -f -o cat` via SSE

> In production the UI calls `/ui/api/*` through Nginx, which injects `X-API-Key`.

---

## Production Install (AlmaLinux 9)

### One-shot installer
Run this from the **repo root**:

```bash
sudo bash scripts/install_kumo_ui.sh --domain mail.example.com --api-key "LONG_RANDOM_SECRET"
```

What it does:
1. Installs Node 18, Nginx, tools
2. Creates service user `kumoapi` + grants journal access  
   (`usermod -aG systemd-journal kumoapi`)
3. Copies `kumo-ui-api` → `/opt/kumo-ui-api`, writes `.env`, installs deps
4. Writes systemd unit running as `kumoapi` with `SupplementaryGroups=systemd-journal`
5. (Optional) Applies ACLs for `/var/log/kumomta` if present  
   (`setfacl -Rm u:kumoapi:rx /var/log/kumomta` and default ACL)
6. Builds the UI → deploys to `/var/www/kumo-ui`
7. Writes Nginx site for `/ui/` and `/ui/api/` with `X-API-Key` injection
8. Reloads Nginx and starts the API

Open: `http://mail.example.com/ui/`

---

## Security Notes

- **Never** expose KumoMTA’s HTTP externally. Bind to `127.0.0.1:8000`.
- The browser hits `/ui/api/*` → Nginx → local proxy (with `X-API-Key`).
- Store secrets in `.env` (not committed). Commit only `.env.example`.
- Consider Basic Auth or JWT in front of the UI for multi-tenant setups.

---

## Wiring to Your Backend (MagicSMTP)

The UI shows TOML and tables as **stubs**. For real edits:
- Add endpoints in your own backend (MagicSMTP) to read/write:
  - **Shaping** profiles (TOML)
  - **Pool/Source** definitions
  - **Domains/DKIM** metadata & key rotation
- Trigger a safe **policy reload** after writes.

---

## Build & Deploy Manually (without installer)

**Proxy**
```bash
cd kumo-ui-api
cp .env.example .env  # set API_KEY and KUMO_HTTP
npm install --omit=dev
sudo cp systemd/kumo-ui-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kumo-ui-api
```

**UI**
```bash
cd kumo-ui
echo "VITE_API_BASE=/ui/api" > .env.production
npm install
npm run build
sudo mkdir -p /var/www/kumo-ui
sudo rsync -a dist/ /var/www/kumo-ui/
```

**Nginx**
```bash
sudo cp nginx/kumo-ui.conf /etc/nginx/conf.d/
sudo sed -i 's/YOUR_HOSTNAME/mail.example.com/' /etc/nginx/conf.d/kumo-ui.conf
sudo sed -i 's/CHANGE_ME/LONG_RANDOM_SECRET/' /etc/nginx/conf.d/kumo-ui.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## API Endpoints (behind Nginx)

- `GET  /ui/api/metrics` → Kumo metrics JSON
- `POST /ui/api/policy/reload` → reload Kumo policy
- `POST /ui/api/queue/flush` → (stub) flush queues/maintenance
- `GET  /ui/api/logs/stream` → SSE live logs

All calls require header: `X-API-Key: <your-secret>`

---

## License

MIT
