#!/usr/bin/env bash
# Run on the Vultr server as root, from /srv/nestguard:   bash deploy/setup.sh nestguard.xyz
# Safe to run again: it is also the "update" command after a git pull.
# With no domain yet, run it without arguments: it uses <ip>.sslip.io, which also gets https.
set -euo pipefail
cd /srv/nestguard

IP=$(curl -4 -s https://api.ipify.org)
NAMES="${IP//./-}.sslip.io"
[ $# -gt 0 ] && NAMES="$1, $NAMES"
echo "Site names: $NAMES"

echo "== packages"
apt-get update -q
apt-get install -y -q caddy python3-venv nodejs npm git ufw

echo "== service user"
id nestguard >/dev/null 2>&1 || useradd --system --home /srv/nestguard --shell /usr/sbin/nologin nestguard

echo "== backend"
[ -f backend/.env ] || { echo "backend/.env is missing: scp it from your laptop first"; exit 1; }
python3 -m venv backend/.venv
backend/.venv/bin/pip install -q -r backend/requirements.txt
chown -R nestguard:nestguard backend
chmod 600 backend/.env
cp deploy/nestguard-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nestguard-api
systemctl restart nestguard-api

echo "== frontend"
(cd app && npm ci --no-audit --no-fund && npm run build)

echo "== caddy"
sed "s|SITE_NAMES|$NAMES|" deploy/Caddyfile > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "== firewall (ssh + web only; port 8000 stays private)"
ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw --force enable >/dev/null

sleep 2
curl -s -o /dev/null -w "API on the server: HTTP %{http_code}\n" "http://127.0.0.1:8000/zones?lat=42.73&lon=-73.68"
echo "Done. Open: https://${NAMES%%,*}"
