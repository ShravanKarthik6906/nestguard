#!/usr/bin/env bash
# Run on the Vultr server as root, from /srv/nestguard:   bash deploy/setup.sh nestguard.xyz
# (the domain only needs to be given once; it also serves www.nestguard.xyz)
# Safe to run again: it is also the "update" command after a git pull.
# With no domain yet, run it without arguments: it uses <ip>.sslip.io, which also gets https.
set -euo pipefail
cd /srv/nestguard

IP=$(curl -4 -s https://api.ipify.org)
NAMES="${IP//./-}.sslip.io"
# The domain is remembered after the first time, so the everyday update command
# (bash deploy/setup.sh, no arguments) keeps it. Give a new one to replace it.
DOMAIN_FILE=/etc/nestguard-domain
if [ $# -gt 0 ]; then
  echo "$1" > "$DOMAIN_FILE"
fi
if [ -s "$DOMAIN_FILE" ]; then
  DOMAIN=$(cat "$DOMAIN_FILE")
  NAMES="$DOMAIN, www.$DOMAIN, $NAMES"
fi
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

echo "== flight simulator (/fly)"
# Needs Node 22+, so it gets a private copy in /opt/node22; the system Node above is not changed.
# If anything here fails, the main app still deploys; only /fly is affected.
install_node22() {
  if [ -x /opt/node22/bin/node ] && /opt/node22/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=17)?0:1)'; then
    return 0
  fi
  local arch
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "unknown CPU type"; return 1 ;; esac
  local base=https://nodejs.org/dist/latest-v22.x
  local sums tarball
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || return 1
  tarball=$(echo "$sums" | grep -o "node-v22[0-9.]*-linux-$arch.tar.xz" | head -1)
  [ -n "$tarball" ] || return 1
  curl -fsSL "$base/$tarball" -o "/tmp/$tarball" &&
    (cd /tmp && echo "$sums" | grep " $tarball\$" | sha256sum -c -) &&
    rm -rf /opt/node22 && mkdir -p /opt/node22 &&
    tar -xJf "/tmp/$tarball" -C /opt/node22 --strip-components=1 &&
    rm -f "/tmp/$tarball"
}
build_sim() {
  [ -s sim/.env.local ] || echo "NOTE: sim/.env.local (Cesium token) is missing, the 3D view will say so"
  (cd sim && PATH=/opt/node22/bin:$PATH npm ci --no-audit --no-fund && PATH=/opt/node22/bin:$PATH npm run build)
}
start_sim_backend() {
  cp deploy/knowflyzone-sim.service /etc/systemd/system/ &&
    systemctl daemon-reload &&
    systemctl enable knowflyzone-sim &&
    systemctl restart knowflyzone-sim
}
if install_node22 && build_sim && start_sim_backend; then
  echo "Flight simulator built and its backend restarted"
else
  echo "WARNING: flight simulator step failed (the main app still deploys). Check the lines above."
fi

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
curl -s -o /dev/null -w "Simulator backend: HTTP %{http_code}\n" "http://127.0.0.1:3001/api/health" || true
echo "Done. Open: https://${NAMES%%,*}"
