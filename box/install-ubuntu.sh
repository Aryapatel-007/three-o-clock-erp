#!/usr/bin/env bash
# Sets up a cafe box from a fresh Ubuntu 24.04 LTS Server. P62, docs/DEPLOYMENT.md section 17.
#
#   sudo LAN_IP=192.168.1.10 bash box/install-ubuntu.sh
#
# Run from a checkout of this repository on the box. It is safe to run again:
# each step checks before it changes anything. It does not touch the router;
# the fixed address is a DHCP reservation made on the router (section 17.3).
#
# What it does:
#   1. Node.js 22, MongoDB Community 8.0, avahi (the cafe-server.local name),
#      chrony (time over NTP), NetworkManager.
#   2. MongoDB as a single-node replica set with authentication, bound to the
#      box and the LAN only, and five logins (box/mongo/init-replica-set.js).
#   3. The app in /opt/cafe-pos, built, its .env written, indexes built.
#   4. systemd: the server on every boot, the hourly snapshot timer.
#   5. Prints the passwords ONCE. Put them in the owner's password manager.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
: "${LAN_IP:?Set LAN_IP to the fixed address of the box, for example LAN_IP=192.168.1.10}"
HOSTNAME_WANTED="${BOX_HOSTNAME:-cafe-server}"
APP_DIR=/opt/cafe-pos
DATA_DIR=/var/lib/cafe-pos
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
secret() { openssl rand -base64 36 | tr -d '/+=' | cut -c1-32; }

echo "== 1. Packages"
apt-get update -y
apt-get install -y curl gnupg ca-certificates avahi-daemon chrony network-manager openssl rsync
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v mongod >/dev/null; then
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update -y
  apt-get install -y mongodb-org mongodb-database-tools mongodb-mongosh
fi

echo "== 2. The name staff can type: ${HOSTNAME_WANTED}.local"
hostnamectl set-hostname "$HOSTNAME_WANTED"
systemctl enable --now avahi-daemon

echo "== 3. Time: NTP whenever online (P62 section 2.6)"
systemctl enable --now chrony
timedatectl set-ntp true
timedatectl set-timezone Asia/Kolkata
# The hardware clock in UTC, so a power cut comes back to the right instant.
timedatectl set-local-rtc 0

echo "== 4. MongoDB: single-node replica set, authentication, LAN only"
id -u cafe >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin cafe
mkdir -p /etc/mongodb
if [[ ! -f /etc/mongodb/keyfile ]]; then
  openssl rand -base64 756 > /etc/mongodb/keyfile
fi
chown mongodb:mongodb /etc/mongodb/keyfile && chmod 400 /etc/mongodb/keyfile
sed "s/LAN_IP/${LAN_IP}/" "$REPO_DIR/box/mongo/mongod.conf" > /etc/mongod.conf
systemctl enable mongod
systemctl restart mongod
sleep 5

CRED_FILE=/root/cafe-pos-credentials.txt
if [[ ! -f "$CRED_FILE" ]]; then
  export ADMIN_PASSWORD="$(secret)" APP_PASSWORD="$(secret)" BACKUP_PASSWORD="$(secret)" COMPASS_PASSWORD="$(secret)" REPAIR_PASSWORD="$(secret)"
  mongosh --quiet "mongodb://127.0.0.1:27017/admin?directConnection=true" "$REPO_DIR/box/mongo/init-replica-set.js"
  umask 077
  {
    printf 'cafe_admin   %s\n' "$ADMIN_PASSWORD"
    printf 'cafe_app     %s\n' "$APP_PASSWORD"
    printf 'cafe_backup  %s\n' "$BACKUP_PASSWORD"
    printf 'cafe_compass %s   read only, the one saved in Compass\n' "$COMPASS_PASSWORD"
    printf 'cafe_repair  %s   never saved in Compass, docs/RUNBOOK.md section 3\n' "$REPAIR_PASSWORD"
  } > "$CRED_FILE"
else
  echo "Logins already made; reading $CRED_FILE."
  APP_PASSWORD="$(awk '/^cafe_app/{print $2}' "$CRED_FILE")"
  BACKUP_PASSWORD="$(awk '/^cafe_backup/{print $2}' "$CRED_FILE")"
fi

echo "== 5. The app"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude node_modules --exclude .git --exclude .env --exclude box-data "$REPO_DIR/" "$APP_DIR/"
chown -R cafe:cafe "$APP_DIR" "$DATA_DIR"
if [[ ! -f "$APP_DIR/.env" ]]; then
  umask 077
  cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=80
DEPLOYMENT_ROLE=BOX
MONGO_URI=mongodb://cafe_app:${APP_PASSWORD}@127.0.0.1:27017/restaurant-erp?replicaSet=rs0&authSource=admin
JWT_ACCESS_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)
INTEGRATION_SECRETS_KEY=$(openssl rand -base64 32)
CLIENT_ORIGIN=http://${LAN_IP}
TRUST_PROXY=false
BOX_DATA_DIR=${DATA_DIR}
# Empty: the address staff open is worked out from the network the box is on,
# so it follows the box to another WiFi. Set them only to pin a fixed address.
BOX_PUBLIC_URL=
BOX_LOCAL_NAME_URL=
BOX_WIFI_CONTROL=off
# Fill these two to ship to the cloud mirror (docs/DEPLOYMENT.md section 18):
MIRROR_URL=
REPLICATION_SECRET=
ENV
  cat > "$APP_DIR/.env.snapshot" <<ENV
MONGO_URI=mongodb://cafe_backup:${BACKUP_PASSWORD}@127.0.0.1:27017/?replicaSet=rs0&authSource=admin
ENV
  chown cafe:cafe "$APP_DIR/.env" "$APP_DIR/.env.snapshot"
fi
cd "$APP_DIR"
sudo -u cafe npm ci --no-audit --no-fund
sudo -u cafe npm run build
sudo -u cafe bash -c 'set -a; . ./.env; set +a; npm run db:indexes'

echo "== 6. Services: the server on every boot, the hourly snapshot"
cp "$REPO_DIR/box/systemd/cafe-pos.service" "$REPO_DIR/box/systemd/cafe-snapshot.service" "$REPO_DIR/box/systemd/cafe-snapshot.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cafe-pos.service cafe-snapshot.timer

echo
echo "Done. Open http://${LAN_IP} (or http://${HOSTNAME_WANTED}.local) on a tablet on the cafe WiFi."
echo "The database logins are in ${CRED_FILE}. Copy them to the owner's password manager now."
echo "Next: docs/DEPLOYMENT.md section 17.6 (the acceptance checks) and docs/STAFF-SETUP.md."
